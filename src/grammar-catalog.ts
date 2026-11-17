// Catalogue des grammaires TextMate apportées par des extensions VS Code : lecture des manifestes (`contributes.languages`
// et `contributes.grammars` du package.json), puis résolution fichier → langage → grammaire. Module sans dépendance Node,
// partagé par le processus principal (qui lit les fichiers) et la page (qui colore avec Monaco).

// Provenances, de la moins à la plus prioritaire. Les grammaires intégrées à VS Code ne servent qu'en dernier recours :
// Monarch garde les langages qu'il connaît, elles complètent (et fournissent les langages embarqués, CSS dans HTML…).
export type ExtensionSource = 'builtin' | 'installed' | 'imported';
export const SOURCES: readonly ExtensionSource[] = ['builtin', 'installed', 'imported'];
const rank = (source: ExtensionSource) => SOURCES.indexOf(source);

export type Pair = [string, string];
export interface LanguageConfiguration {
  comments: { lineComment?: string; blockComment?: Pair };
  brackets: Pair[];
  autoClosingPairs: { open: string; close: string }[];
  surroundingPairs: { open: string; close: string }[];
}

// Ce qu'une extension apporte à la coloration, d'après son manifeste.
export interface ManifestGrammar {
  scopeName: string;
  path: string;
  language: string | null;
  injectTo: string[];
  embeddedLanguages: Record<string, string>;
}
export interface ManifestLanguage {
  id: string;
  extensions: string[];
  filenames: string[];
  aliases: string[];
  configuration: string | null;
  // Configuration lue sur le disque par le processus principal.
  configurationData?: LanguageConfiguration | null;
}
export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  source: ExtensionSource;
  languages: ManifestLanguage[];
  grammars: ManifestGrammar[];
}

// Catalogue envoyé à la page.
export interface CatalogExtension {
  id: string;
  name: string;
  version: string;
  source: ExtensionSource;
  languages: string[];
}
export interface CatalogGrammar {
  scopeName: string;
  language: string | null;
  injectTo: string[];
  embeddedLanguages: Record<string, string>;
  extension: string;
  source: ExtensionSource;
}
export interface CatalogLanguage {
  id: string;
  aliases: string[];
  configuration: LanguageConfiguration | null;
  scopeName: string | null;
  source: ExtensionSource;
}
// Association fichier → langage : par extension (`.ts`) ou par nom de fichier exact (`Dockerfile`).
export type CatalogClaim = { language: string; source: ExtensionSource; order: number }
  & ({ extension: string; filename?: undefined } | { filename: string; extension?: undefined });
export interface GrammarCatalog {
  extensions: CatalogExtension[];
  grammars: Record<string, CatalogGrammar>;
  languages: Record<string, CatalogLanguage>;
  claims: CatalogClaim[];
}

// Contenu JSON lu sur le disque : forme non garantie, chaque champ est vérifié avant usage.
type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose => Boolean(value) && typeof value === 'object';

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item)) : []);

// JSON avec commentaires et virgules finales, format des fichiers de configuration de langage de VS Code.
export function parseJsonc(text: string): unknown {
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
export function relativePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' || part.includes(':')) return null;
    parts.push(part);
  }
  return parts.length && !/^[/\\]/.test(value) ? parts.join('/') : null;
}

// Retient d'une extension ce qui sert à la coloration ; null si elle n'apporte aucune grammaire.
export function readManifest(manifest: unknown, source: ExtensionSource): ExtensionManifest | null {
  if (!isObject(manifest) || typeof manifest.name !== 'string') return null;
  const contributes = isObject(manifest.contributes) ? manifest.contributes : {};
  const grammars: ManifestGrammar[] = (Array.isArray(contributes.grammars) ? contributes.grammars as unknown[] : [])
    .filter((grammar): grammar is Loose & { scopeName: string } => isObject(grammar) && typeof grammar.scopeName === 'string' && Boolean(relativePath(grammar.path)))
    .map((grammar) => ({
      scopeName: grammar.scopeName,
      path: relativePath(grammar.path) as string,
      language: typeof grammar.language === 'string' ? grammar.language : null,
      injectTo: strings(grammar.injectTo),
      embeddedLanguages: Object.fromEntries(Object.entries(isObject(grammar.embeddedLanguages) ? grammar.embeddedLanguages : {})
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    }));
  if (!grammars.length) return null;
  const languages: ManifestLanguage[] = (Array.isArray(contributes.languages) ? contributes.languages as unknown[] : [])
    .filter((language): language is Loose & { id: string } => isObject(language) && typeof language.id === 'string')
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
export function compareExtensionVersions(left: unknown, right: unknown): number {
  const parse = (text: unknown) => String(text).split(/[-+]/)[0].split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return Math.sign((a[index] ?? 0) - (b[index] ?? 0));
  }
  return 0;
}

// Ne garde que la configuration de langage utile à Monaco (commentaires, paires de délimiteurs), en chaînes seulement.
export function languageConfiguration(raw: unknown): LanguageConfiguration | null {
  if (!isObject(raw)) return null;
  const pair = (item: unknown): Pair | null => (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string' ? [item[0], item[1]]
    : isObject(item) && typeof item.open === 'string' && typeof item.close === 'string' ? [item.open, item.close] : null);
  const pairs = (list: unknown): Pair[] => (Array.isArray(list) ? list.map(pair).filter((item): item is Pair => Boolean(item)) : []);
  const comments: LanguageConfiguration['comments'] = {};
  const rawComments = isObject(raw.comments) ? raw.comments : undefined;
  if (typeof rawComments?.lineComment === 'string') comments.lineComment = rawComments.lineComment;
  const block = pair(rawComments?.blockComment);
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
export function buildCatalog(extensions: readonly ExtensionManifest[]): GrammarCatalog {
  const ordered = [...extensions].sort((a, b) => rank(a.source) - rank(b.source));
  const grammars: Record<string, CatalogGrammar> = {};
  const languages: Record<string, CatalogLanguage> = {};
  const claims: CatalogClaim[] = [];
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
      const language = languages[grammar.language] ?? { id: grammar.language, aliases: [], configuration: null, scopeName: null, source: extension.source };
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
export function resolveLanguage(filePath: string, catalog: GrammarCatalog | null | undefined, sources: readonly ExtensionSource[] = SOURCES): { language: string; scopeName: string } | null {
  if (!catalog) return null;
  const name = String(filePath).split(/[/\\]/).pop()!.toLowerCase();
  let best: CatalogClaim | null = null;
  let bestScore: number[] | null = null;
  for (const claim of catalog.claims) {
    if (!sources.includes(claim.source)) continue;
    const matches = claim.filename ? claim.filename === name : name.endsWith(claim.extension!);
    if (!matches || !catalog.languages[claim.language]?.scopeName) continue;
    const score = [claim.filename ? 1 : 0, claim.extension?.length ?? 0, rank(claim.source), claim.order];
    const previous = bestScore;
    const index = previous ? score.findIndex((value, position) => value !== previous[position]) : 0;
    if (!previous || (index >= 0 && score[index] > previous[index])) {
      best = claim;
      bestScore = score;
    }
  }
  return best ? { language: best.language, scopeName: catalog.languages[best.language].scopeName as string } : null;
}

// Grammaires qui s'injectent dans une portée (balises Astro dans le Markdown…).
export function injectionsFor(scopeName: string, catalog: GrammarCatalog | null | undefined): string[] {
  return Object.values(catalog?.grammars ?? {}).filter((grammar) => grammar.injectTo.includes(scopeName)).map((grammar) => grammar.scopeName);
}

// Jeton Monaco d'un segment TextMate : la portée la plus intérieure qu'une règle du thème colore (une ponctuation de
// chaîne prend ainsi la couleur de la chaîne). Le préfixe `tm.` isole ces règles de celles des grammaires Monarch.
export function pickToken(scopes: readonly string[], prefixes: readonly string[]): string {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const scope = scopes[index];
    if (prefixes.some((prefix) => scope === prefix || scope.startsWith(`${prefix}.`))) return `tm.${scope}`;
  }
  return '';
}
