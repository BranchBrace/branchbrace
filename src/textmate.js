// Modules CommonJS marqués `__esModule` sans export par défaut : l'import par défaut vaut `module.exports` sous Node et au
// build, mais `undefined` sous Vite en développement. L'espace de noms se ramène partout à `module.exports` : en `default`
// sous Node et au build, ou lui-même sous Vite en développement.
import * as textmateModule from 'vscode-textmate';
import * as onigurumaModule from 'vscode-oniguruma';
import { injectionsFor, pickToken, resolveLanguage } from './grammar-catalog.js';

const { INITIAL, Registry, parseRawGrammar } = textmateModule.default ?? textmateModule;
const { createOnigScanner, createOnigString, loadWASM } = onigurumaModule.default ?? onigurumaModule;

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
let monacoApi = null;
let registry = null;
let onig = null;
let generation = 0;
let fallback = () => 'plaintext';
let registrations = [];
// Fabrique de coloration de chaque langage `tm.<id>`, et langages dont la grammaire n'a pas pu être chargée.
const factories = new Map();
const failed = new Set();

// Un échec (onig.wasm absent ou refusé par le processus principal) n'est pas gardé en cache : le fichier suivant retente.
function onigLib() {
  if (!onig) {
    const pending = window.workbench.onigWasm()
      .then((bytes) => loadWASM(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)))
      .then(() => ({ createOnigScanner, createOnigString }));
    onig = pending;
    pending.catch(() => { if (onig === pending) onig = null; });
  }
  return onig;
}

// Registre vscode-textmate, créé une fois Oniguruma chargé : un registre construit sur un moteur en échec le resterait.
async function textMateRegistry() {
  const lib = await onigLib();
  registry ??= new Registry({
    onigLib: Promise.resolve(lib),
    loadGrammar: async (scopeName) => {
      if (!catalog?.grammars[scopeName]) return null;
      try {
        const { path, content } = await window.workbench.readGrammar(scopeName);
        return parseRawGrammar(content, path);
      } catch { return null; }
    },
    getInjections: (scopeName) => injectionsFor(scopeName, catalog),
  });
  return registry;
}

function registerFactory(id, scopeName) {
  factories.get(id)?.dispose();
  factories.set(id, monacoApi.languages.registerTokensProviderFactory(id, { create: () => tokensProvider(id, scopeName) }));
}

// Grammaire indisponible (plus de 10 Mo, illisible, moteur absent) : les fichiers ouverts dans ce langage repassent sur
// le langage de repli (Monarch équivalent), et la fabrique est réinscrite, Monaco n'en rappelant jamais une résolue. Une
// grammaire en échec est écartée jusqu'au prochain catalogue ; un moteur en échec est retenté au fichier suivant.
function giveUp(id, scopeName, grammarFailed) {
  if (grammarFailed) failed.add(id);
  const target = fallback(id);
  for (const model of monacoApi.editor.getModels()) {
    if (model.getLanguageId() === id && target !== id) monacoApi.editor.setModelLanguage(model, target);
  }
  registerFactory(id, scopeName);
}

async function tokensProvider(id, scopeName) {
  const started = generation;
  let grammar = null;
  try {
    const current = await textMateRegistry();
    try { grammar = await current.loadGrammar(scopeName); } catch { grammar = null; }
  } catch {
    if (started === generation) giveUp(id, scopeName, false);
    return null;
  }
  if (!grammar) {
    if (started === generation) giveUp(id, scopeName, true);
    return null;
  }
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

// Langage de repli d'un langage `tm.<id>` dont la grammaire échoue (le Monarch équivalent, sinon `plaintext`).
export function setFallback(resolve) {
  fallback = resolve;
}

// Installe (ou remplace, après un import ou un retrait d'extension) les langages TextMate. Les fichiers déjà ouverts
// gardent leur coloration jusqu'à leur réouverture.
export function applyCatalog(monaco, next) {
  for (const registration of [...registrations, ...factories.values()]) registration.dispose();
  registrations = [];
  factories.clear();
  failed.clear();
  generation += 1;
  // L'ancien registre libère ses OnigScanner du tas WebAssembly ; le suivant est recréé à la première grammaire.
  registry?.dispose();
  registry = null;
  monacoApi = monaco;
  catalog = next;
  const known = new Set(monaco.languages.getLanguages().map((language) => language.id));
  for (const language of Object.values(catalog.languages)) {
    if (!language.scopeName) continue;
    const id = `tm.${language.id}`;
    if (!known.has(id)) monaco.languages.register({ id, aliases: language.aliases });
    if (language.configuration) registrations.push(monaco.languages.setLanguageConfiguration(id, configuration(language.configuration)));
    registerFactory(id, language.scopeName);
  }
}

// Langage Monaco `tm.<id>` d'un fichier, si une grammaire des provenances demandées le couvre et n'a pas échoué.
export function textMateLanguage(filePath, sources) {
  const found = resolveLanguage(filePath, catalog, sources);
  return found && !failed.has(`tm.${found.language}`) ? `tm.${found.language}` : null;
}

// Langage Monaco d'un nom de fichier : une extension installée ou importée l'emporte sur Monarch (`monarch(name)`) ; les
// grammaires intégrées à VS Code ne couvrent que les fichiers que Monarch ne sait pas colorer.
export function fileLanguage(name, monarch) {
  return textMateLanguage(name, ['installed', 'imported']) || monarch(name) || textMateLanguage(name, ['builtin']) || 'plaintext';
}

// Repli d'un langage `tm.<id>` en échec : le langage qu'auraient eu ses fichiers sans cette grammaire.
export function fallbackLanguage(id, monarch) {
  const language = id.replace(/^tm\./, '');
  for (const claim of catalog?.claims ?? []) {
    if (claim.language !== language) continue;
    const name = claim.filename ?? `file${claim.extension}`;
    const found = monarch(name) || textMateLanguage(name, ['builtin']);
    if (found && found !== id) return found;
  }
  return 'plaintext';
}

// Premier catalogue : le premier diff ne l'attend pas plus de `timeout` ms. Au-delà, Monarch colore seul et le catalogue
// s'applique à son arrivée (sauf si un autre, plus récent, l'a déjà été entre-temps).
// `request` est la fonction qui demande le catalogue au processus principal.
export async function loadCatalog(monaco, request, timeout = 1500) {
  const pending = Promise.resolve().then(request).then((value) => ({ value }), () => null);
  let timer;
  const first = await Promise.race([pending, new Promise((resolve) => { timer = setTimeout(resolve, timeout, 'timeout'); })]);
  clearTimeout(timer);
  if (first !== 'timeout') {
    if (first?.value) applyCatalog(monaco, first.value);
    return;
  }
  pending.then((result) => { if (result?.value && !catalog) applyCatalog(monaco, result.value); });
}

export const grammarCatalog = () => catalog;
