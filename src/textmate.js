import { INITIAL, Registry, parseRawGrammar } from 'vscode-textmate';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';
import { injectionsFor, pickToken, resolveLanguage } from './grammar-catalog.js';

// Coloration par les grammaires TextMate des extensions VS Code, branchée sur Monaco. Chaque langage couvert devient un
// langage Monaco `tm.<id>` dont la grammaire n'est chargée (par IPC) qu'à la première utilisation. Le moteur d'expressions
// régulières (Oniguruma, en WebAssembly) est lu par le processus principal depuis le paquet installé : aucun réseau.

// Couleurs des portées TextMate, reprises du thème Dark+ de VS Code : la même famille que les couleurs Monarch de
// vs-dark, pour qu'un fichier coloré par une extension ne détonne pas à côté des autres.
const TOKEN_RULES = [
  ['comment', '6A9955'],
  ['string', 'CE9178'],
  ['string.regexp', 'D16969'],
  ['constant.character.escape', 'D7BA7D'],
  ['constant.numeric', 'B5CEA8'],
  ['constant.language', '569CD6'],
  ['constant.character', '569CD6'],
  ['constant.other', '4FC1FF'],
  ['variable.other.constant', '4FC1FF'],
  ['keyword', '569CD6'],
  ['keyword.operator', 'D4D4D4'],
  ['keyword.operator.expression', '569CD6'],
  ['keyword.operator.new', '569CD6'],
  ['keyword.control', 'C586C0'],
  ['storage', '569CD6'],
  ['storage.type', '569CD6'],
  ['entity.name.function', 'DCDCAA'],
  ['support.function', 'DCDCAA'],
  ['entity.name.type', '4EC9B0'],
  ['entity.name.class', '4EC9B0'],
  ['entity.name.namespace', '4EC9B0'],
  ['entity.other.inherited-class', '4EC9B0'],
  ['support.type', '4EC9B0'],
  ['support.class', '4EC9B0'],
  ['support.type.property-name', '9CDCFE'],
  ['entity.name.tag', '569CD6'],
  ['entity.name.tag.css', 'D7BA7D'],
  ['entity.other.attribute-name', '9CDCFE'],
  ['entity.other.attribute-name.class.css', 'D7BA7D'],
  ['entity.other.attribute-name.id.css', 'D7BA7D'],
  ['punctuation.definition.tag', '808080'],
  ['variable', '9CDCFE'],
  ['variable.language', '569CD6'],
  ['variable.parameter', '9CDCFE'],
  ['support.variable', '9CDCFE'],
  ['support.constant', '4FC1FF'],
  ['support.constant.property-value', 'CE9178'],
  ['meta.object-literal.key', '9CDCFE'],
  ['entity.name.label', 'C8C8C8'],
  ['markup.heading', '569CD6', 'bold'],
  ['markup.bold', '', 'bold'],
  ['markup.italic', '', 'italic'],
  ['markup.underline', '', 'underline'],
  ['markup.inserted', 'B5CEA8'],
  ['markup.deleted', 'CE9178'],
  ['markup.changed', '569CD6'],
  ['markup.inline.raw', 'CE9178'],
  ['markup.quote', '6A9955'],
  ['invalid', 'F44747'],
];
const PREFIXES = TOKEN_RULES.map(([scope]) => scope);
export const themeRules = TOKEN_RULES.map(([scope, foreground, fontStyle]) => ({ token: `tm.${scope}`, ...(foreground && { foreground }), ...(fontStyle && { fontStyle }) }));

let catalog = null;
let registrations = [];
let onig = null;

function onigLib() {
  onig ??= window.workbench.onigWasm()
    .then((bytes) => loadWASM(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)))
    .then(() => ({ createOnigScanner, createOnigString }));
  return onig;
}

async function tokensProvider(registry, scopeName) {
  const grammar = await registry.loadGrammar(scopeName);
  if (!grammar) return null;
  return {
    getInitialState: () => INITIAL,
    tokenize(line, state) {
      // Une ligne pathologique ne bloque pas l'interface : au-delà de 500 ms, la suite de la ligne reste sans couleur.
      const result = grammar.tokenizeLine(line, state, 500);
      return { endState: result.ruleStack, tokens: result.tokens.map((token) => ({ startIndex: token.startIndex, scopes: pickToken(token.scopes, PREFIXES) })) };
    },
  };
}

function configuration({ comments, brackets, autoClosingPairs, surroundingPairs }) {
  return {
    ...(Object.keys(comments).length && { comments }),
    ...(brackets.length && { brackets }),
    ...(autoClosingPairs.length && { autoClosingPairs }),
    ...(surroundingPairs.length && { surroundingPairs }),
  };
}

// Installe (ou remplace, après un import ou un retrait d'extension) les langages TextMate. Les fichiers déjà ouverts
// gardent leur coloration jusqu'à leur réouverture.
export function applyCatalog(monaco, next) {
  for (const registration of registrations) registration.dispose();
  registrations = [];
  catalog = next;
  const registry = new Registry({
    onigLib: onigLib(),
    loadGrammar: async (scopeName) => {
      if (!catalog?.grammars[scopeName]) return null;
      try {
        const { path, content } = await window.workbench.readGrammar(scopeName);
        return parseRawGrammar(content, path);
      } catch { return null; }
    },
    getInjections: (scopeName) => injectionsFor(scopeName, catalog),
  });
  const known = new Set(monaco.languages.getLanguages().map((language) => language.id));
  for (const language of Object.values(catalog.languages)) {
    if (!language.scopeName) continue;
    const id = `tm.${language.id}`;
    if (!known.has(id)) monaco.languages.register({ id, aliases: language.aliases });
    if (language.configuration) registrations.push(monaco.languages.setLanguageConfiguration(id, configuration(language.configuration)));
    registrations.push(monaco.languages.registerTokensProviderFactory(id, { create: () => tokensProvider(registry, language.scopeName) }));
  }
}

// Langage Monaco `tm.<id>` d'un fichier, si une grammaire des provenances demandées le couvre.
export function textMateLanguage(filePath, sources) {
  const found = resolveLanguage(filePath, catalog, sources);
  return found ? `tm.${found.language}` : null;
}

export const grammarCatalog = () => catalog;
