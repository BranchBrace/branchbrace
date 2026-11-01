// Catalogue des grammaires TextMate apportées par des extensions VS Code : lecture des manifestes (`contributes.languages`
// et `contributes.grammars` du package.json), puis résolution fichier → langage → grammaire. Module sans dépendance Node,
// partagé par le processus principal (qui lit les fichiers) et la page (qui colore avec Monaco).

// Provenances, de la moins à la plus prioritaire. Les grammaires intégrées à VS Code ne servent qu'en dernier recours :
// Monarch garde les langages qu'il connaît, elles complètent (et fournissent les langages embarqués, CSS dans HTML…).
export const SOURCES = ['builtin', 'installed', 'imported'];
const rank = (source) => SOURCES.indexOf(source);

const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : []);

// JSON avec commentaires et virgules finales, format des fichiers de configuration de langage de VS Code.
export function parseJsonc(text) {
  let output = '';
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      output += char;
      if (char === '\\') { output += text[index + 1] ?? ''; index += 1; } else if (char === '"') inString = false;
    } else if (char === '"') { inString = true; output += char; } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      output += '\n';
    } else if (char === '/' && text[index + 1] === '*') {
      index = text.indexOf('*/', index + 2);
      if (index < 0) break;
      index += 1;
    } else output += char;
  }
  return JSON.parse(output.replace(/^﻿/, '').replace(/,(\s*[}\]])/g, '$1'));
}

// Chemin relatif au dossier de l'extension, sans remontée ni chemin absolu ; null s'il sort du dossier.
export function relativePath(value) {
  if (typeof value !== 'string' || !value) return null;
  const parts = [];
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' || part.includes(':')) return null;
    parts.push(part);
  }
  return parts.length && !/^[/\\]/.test(value) ? parts.join('/') : null;
}

// Retient d'une extension ce qui sert à la coloration ; null si elle n'apporte aucune grammaire.
export function readManifest(manifest, source) {
  if (!manifest || typeof manifest !== 'object' || typeof manifest.name !== 'string') return null;
  const contributes = manifest.contributes && typeof manifest.contributes === 'object' ? manifest.contributes : {};
  const grammars = (Array.isArray(contributes.grammars) ? contributes.grammars : [])
    .filter((grammar) => grammar && typeof grammar.scopeName === 'string' && relativePath(grammar.path))
    .map((grammar) => ({
      scopeName: grammar.scopeName,
      path: relativePath(grammar.path),
      language: typeof grammar.language === 'string' ? grammar.language : null,
      injectTo: strings(grammar.injectTo),
      embeddedLanguages: Object.fromEntries(Object.entries(grammar.embeddedLanguages && typeof grammar.embeddedLanguages === 'object' ? grammar.embeddedLanguages : {})
        .filter(([, language]) => typeof language === 'string')),
    }));
  if (!grammars.length) return null;
  const languages = (Array.isArray(contributes.languages) ? contributes.languages : [])
    .filter((language) => language && typeof language.id === 'string')
    .map((language) => ({
      id: language.id,
      extensions: strings(language.extensions).map((item) => item.toLowerCase()),
      filenames: strings(language.filenames).map((item) => item.toLowerCase()),
      aliases: strings(language.aliases),
      configuration: relativePath(language.configuration),
    }));
  const publisher = typeof manifest.publisher === 'string' ? manifest.publisher : 'local';
  return {
    id: `${publisher}.${manifest.name}`.toLowerCase(),
    name: typeof manifest.displayName === 'string' && !manifest.displayName.startsWith('%') ? manifest.displayName : manifest.name,
    version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
    source,
    languages,
    grammars,
  };
}

// Comparaison numérique tolérante des versions d'extension (1.10.0 > 1.9.3) ; le suffixe éventuel est ignoré.
export function compareExtensionVersions(left, right) {
  const parse = (text) => String(text).split(/[-+]/)[0].split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return Math.sign((a[index] ?? 0) - (b[index] ?? 0));
  }
  return 0;
}

// Ne garde que la configuration de langage utile à Monaco (commentaires, paires de délimiteurs), en chaînes seulement.
export function languageConfiguration(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pair = (item) => (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string' ? [item[0], item[1]]
    : item && typeof item.open === 'string' && typeof item.close === 'string' ? [item.open, item.close] : null);
  const pairs = (list) => (Array.isArray(list) ? list.map(pair).filter(Boolean) : []);
  const comments = {};
  if (typeof raw.comments?.lineComment === 'string') comments.lineComment = raw.comments.lineComment;
  const block = pair(raw.comments?.blockComment);
  if (block) comments.blockComment = block;
  return {
    comments,
    brackets: pairs(raw.brackets),
    autoClosingPairs: pairs(raw.autoClosingPairs).map(([open, close]) => ({ open, close })),
    surroundingPairs: pairs(raw.surroundingPairs).map(([open, close]) => ({ open, close })),
  };
}

// Assemble le catalogue des extensions retenues, dans l'ordre de priorité croissante : une grammaire ou un langage
// apporté plus tard (importé > installé > intégré) remplace le précédent.
export function buildCatalog(extensions) {
  const ordered = [...extensions].sort((a, b) => rank(a.source) - rank(b.source));
  const grammars = {};
  const languages = {};
  const claims = [];
  for (const extension of ordered) {
    for (const grammar of extension.grammars) {
      grammars[grammar.scopeName] = { scopeName: grammar.scopeName, language: grammar.language, injectTo: grammar.injectTo, embeddedLanguages: grammar.embeddedLanguages, extension: extension.id, source: extension.source };
    }
    for (const language of extension.languages) {
      const known = languages[language.id] ?? { id: language.id, aliases: [], configuration: null, scopeName: null, source: extension.source };
      known.aliases = [...new Set([...known.aliases, ...language.aliases])];
      if (language.configurationData) known.configuration = language.configurationData;
      languages[language.id] = known;
      for (const extensionName of language.extensions) claims.push({ extension: extensionName, language: language.id, source: extension.source, order: claims.length });
      for (const filename of language.filenames) claims.push({ filename, language: language.id, source: extension.source, order: claims.length });
    }
  }
  for (const extension of ordered) {
    for (const grammar of extension.grammars) {
      if (!grammar.language) continue;
      const language = languages[grammar.language] ?? { id: grammar.language, aliases: [], configuration: null, scopeName: null };
      language.scopeName = grammar.scopeName;
      language.source = extension.source;
      languages[grammar.language] = language;
    }
  }
  // Une extension installée ou importée qui déclare un langage sans en fournir la grammaire (rust-analyzer pour `.rs`)
  // ne doit pas faire passer ses fichiers sur la grammaire intégrée à VS Code avant Monarch : son association
  // fichier → langage ne compte que si la grammaire du langage vient de la même provenance.
  const kept = claims.filter((claim) => claim.source === 'builtin' || languages[claim.language]?.source === claim.source);
  return {
    extensions: ordered.map(({ id, name, version, source, languages: contributed }) => ({ id, name, version, source, languages: contributed.map((language) => language.id) })),
    grammars,
    languages,
    claims: kept,
  };
}

// Langage TextMate d'un fichier, parmi les provenances demandées : nom de fichier exact d'abord, puis l'extension la
// plus longue (`.d.ts` avant `.ts`), puis la provenance la plus prioritaire et la déclaration la plus récente.
export function resolveLanguage(filePath, catalog, sources = SOURCES) {
  if (!catalog) return null;
  const name = String(filePath).split(/[/\\]/).pop().toLowerCase();
  let best = null;
  let bestScore = null;
  for (const claim of catalog.claims) {
    if (!sources.includes(claim.source)) continue;
    const matches = claim.filename ? claim.filename === name : name.endsWith(claim.extension);
    if (!matches || !catalog.languages[claim.language]?.scopeName) continue;
    const score = [claim.filename ? 1 : 0, claim.extension?.length ?? 0, rank(claim.source), claim.order];
    const index = bestScore ? score.findIndex((value, position) => value !== bestScore[position]) : 0;
    if (!bestScore || (index >= 0 && score[index] > bestScore[index])) {
      best = claim;
      bestScore = score;
    }
  }
  return best ? { language: best.language, scopeName: catalog.languages[best.language].scopeName } : null;
}

// Grammaires qui s'injectent dans une portée (balises Astro dans le Markdown…).
export function injectionsFor(scopeName, catalog) {
  return Object.values(catalog?.grammars ?? {}).filter((grammar) => grammar.injectTo.includes(scopeName)).map((grammar) => grammar.scopeName);
}

// Jeton Monaco d'un segment TextMate : la portée la plus intérieure qu'une règle du thème colore (une ponctuation de
// chaîne prend ainsi la couleur de la chaîne). Le préfixe `tm.` isole ces règles de celles des grammaires Monarch.
export function pickToken(scopes, prefixes) {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const scope = scopes[index];
    if (prefixes.some((prefix) => scope === prefix || scope.startsWith(`${prefix}.`))) return `tm.${scope}`;
  }
  return '';
}
