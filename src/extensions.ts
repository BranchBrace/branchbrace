import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { BranchBraceError } from './git.ts';
import { buildCatalog, compareExtensionVersions, languageConfiguration, parseJsonc, readManifest, relativePath } from './grammar-catalog.ts';
import type { ExtensionManifest, ExtensionSource, GrammarCatalog, ManifestGrammar } from './grammar-catalog.ts';

// Extensions VS Code lues sur le disque pour leurs grammaires TextMate : celles du VS Code installé (et de VSCodium),
// les grammaires intégrées à VS Code, et les .vsix importés dans l'application. Lecture locale seulement, sans réseau ;
// la page ne désigne jamais un fichier par son chemin, seulement une grammaire par sa portée (`source.astro`).
const MAX_GRAMMAR_SIZE = 10 * 1048576;
const MAX_VSIX_SIZE = 512 * 1048576;

export interface ExtensionRoot {
  dir: string;
  source: ExtensionSource;
}
// Extension retenue, avec le fichier de chaque grammaire (portée → chemin absolu).
export interface LoadedExtension extends ExtensionManifest {
  dir: string;
  files: Map<string, string>;
}
export interface GrammarScan {
  catalog: GrammarCatalog;
  files: Map<string, string>;
}
export interface GrammarFile {
  path: string;
  content: string;
}
export interface ImportedExtension {
  id: string;
  name: string;
  version: string;
}
export interface ZipReader {
  has(name: string): boolean;
  read(name: string): Buffer;
}
interface ZipEntry {
  method: number;
  compressed: number;
  size: number;
  local: number;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try { return (await stat(candidate)).isDirectory(); } catch { return false; }
}

// Grammaires intégrées à VS Code (resources/app/extensions). Sous Windows, les versions récentes s'installent dans un
// sous-dossier par version : on prend le plus récent.
async function builtinDirectory({ platform, env, home }: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string }): Promise<string | null> {
  const app = (base: string) => path.join(base, 'resources', 'app', 'extensions');
  const installs = platform === 'win32'
    ? [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code'), env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft VS Code'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'VSCodium')]
    : platform === 'darwin'
      ? ['/Applications/Visual Studio Code.app/Contents', path.join(home, 'Applications', 'Visual Studio Code.app', 'Contents'), '/Applications/VSCodium.app/Contents']
      : ['/usr/share/code', '/opt/visual-studio-code', '/usr/lib/code', '/usr/share/codium', '/opt/vscodium-bin', '/snap/code/current/usr/share/code'];
  for (const install of installs.filter((item): item is string => Boolean(item))) {
    if (await isDirectory(app(install))) return app(install);
    // Arch (code-oss) : les extensions sont directement dans /usr/lib/code/extensions.
    if (await isDirectory(path.join(install, 'extensions')) && install.startsWith('/usr/lib')) return path.join(install, 'extensions');
    let newest: { dir: string; modified: number } | null = null;
    try {
      for (const entry of await readdir(install, { withFileTypes: true })) {
        if (!entry.isDirectory() || !await isDirectory(app(path.join(install, entry.name)))) continue;
        const modified = (await stat(app(path.join(install, entry.name)))).mtimeMs;
        if (!newest || modified > newest.modified) newest = { dir: app(path.join(install, entry.name)), modified };
      }
    } catch { /* pas installé ici */ }
    if (newest) return newest.dir;
  }
  return null;
}

// Dossiers à parcourir, du moins au plus prioritaire.
export interface RootsOptions {
  home: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  imported?: string | null;
}

export async function extensionRoots({ home, platform = process.platform, env = process.env, imported }: RootsOptions): Promise<ExtensionRoot[]> {
  const builtin = await builtinDirectory({ platform, env, home });
  const roots: (ExtensionRoot | string | null | undefined)[] = [
    builtin && { dir: builtin, source: 'builtin' },
    { dir: path.join(home, '.vscode', 'extensions'), source: 'installed' },
    { dir: path.join(home, '.vscode-oss', 'extensions'), source: 'installed' },
    imported && { dir: imported, source: 'imported' },
  ];
  return roots.filter((root): root is ExtensionRoot => Boolean(root));
}

// Versions désinstallées que VS Code n'a pas encore effacées du disque.
async function obsoleteFolders(dir: string): Promise<Set<string>> {
  try { return new Set(Object.keys(JSON.parse(await readFile(path.join(dir, '.obsolete'), 'utf8')) as object)); } catch { return new Set(); }
}

async function loadExtension(folder: string, source: ExtensionSource): Promise<LoadedExtension | null> {
  let manifest: unknown;
  try { manifest = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8')); } catch { return null; }
  const extension = readManifest(manifest, source);
  if (!extension) return null;
  const files = new Map<string, string>();
  const grammars: ManifestGrammar[] = [];
  for (const grammar of extension.grammars) {
    const file = path.join(folder, grammar.path);
    try { if ((await stat(file)).isFile()) { grammars.push(grammar); files.set(grammar.scopeName, file); } } catch { /* grammaire déclarée mais absente */ }
  }
  if (!grammars.length) return null;
  for (const language of extension.languages) {
    if (!language.configuration) continue;
    try { language.configurationData = languageConfiguration(parseJsonc(await readFile(path.join(folder, language.configuration), 'utf8'))); } catch { /* configuration illisible : coloration seule */ }
  }
  return { ...extension, grammars, dir: folder, files };
}

// Parcourt les dossiers d'extensions. Pour une même extension, seule la version la plus récente de chaque provenance compte.
export async function scanExtensions(roots: readonly ExtensionRoot[]): Promise<GrammarScan> {
  const found = new Map<string, LoadedExtension>();
  for (const { dir, source } of roots) {
    let entries: Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    const obsolete = await obsoleteFolders(dir);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || obsolete.has(entry.name)) continue;
      const extension = await loadExtension(path.join(dir, entry.name), source);
      if (!extension) continue;
      const key = `${source}:${extension.id}`;
      const previous = found.get(key);
      if (!previous || compareExtensionVersions(extension.version, previous.version) > 0) found.set(key, extension);
    }
  }
  const extensions = [...found.values()];
  const catalog = buildCatalog(extensions);
  const files = new Map<string, string>();
  for (const extension of extensions.sort((a, b) => ['builtin', 'installed', 'imported'].indexOf(a.source) - ['builtin', 'installed', 'imported'].indexOf(b.source))) {
    for (const [scopeName, file] of extension.files) files.set(scopeName, file);
  }
  return { catalog, files };
}

// Contenu d'une grammaire connue du catalogue ; le nom de fichier indique à vscode-textmate son format (JSON ou plist).
export async function readGrammar(scan: GrammarScan, scopeName: string): Promise<GrammarFile> {
  const file = scan.files.get(scopeName);
  if (!file) throw new BranchBraceError('grammar-not-found');
  if ((await stat(file)).size > MAX_GRAMMAR_SIZE) throw new BranchBraceError('grammar-not-found');
  return { path: path.basename(file), content: await readFile(file, 'utf8') };
}

// Lecteur zip minimal (un .vsix est une archive zip) : répertoire central, entrées stockées ou compressées (deflate).
export function readZip(buffer: Buffer): ZipReader {
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new BranchBraceError('extension-invalid');
  const entries = new Map<string, ZipEntry>();
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = buffer.readUInt16LE(end + 10); index > 0; index -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new BranchBraceError('extension-invalid');
    const nameLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const entry: ZipEntry = { method: buffer.readUInt16LE(offset + 10), compressed: buffer.readUInt32LE(offset + 20), size: buffer.readUInt32LE(offset + 24), local: buffer.readUInt32LE(offset + 42) };
    entries.set(name, entry);
    try { entries.set(decodeURIComponent(name), entry); } catch { /* nom non encodé */ }
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return {
    has: (name: string) => entries.has(name),
    read(name: string) {
      const entry = entries.get(name);
      if (!entry || entry.size > MAX_GRAMMAR_SIZE || buffer.readUInt32LE(entry.local) !== 0x04034b50) throw new BranchBraceError('extension-invalid');
      const start = entry.local + 30 + buffer.readUInt16LE(entry.local + 26) + buffer.readUInt16LE(entry.local + 28);
      const data = buffer.subarray(start, start + entry.compressed);
      if (entry.method === 0) return Buffer.from(data);
      if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_GRAMMAR_SIZE });
      throw new BranchBraceError('extension-invalid');
    },
  };
}

const safeName = (text: unknown) => String(text).replace(/[^a-z0-9._-]/gi, '_');

// Copie d'un .vsix dans le dossier de l'application : seuls le manifeste, les grammaires et les configurations de
// langage sont extraits. Une version déjà importée de la même extension est remplacée.
export async function importVsix(file: string, root: string): Promise<ImportedExtension> {
  const buffer = await readFile(file);
  if (buffer.length > MAX_VSIX_SIZE) throw new BranchBraceError('extension-invalid');
  let zip: ZipReader;
  let extension: ExtensionManifest | null;
  try {
    zip = readZip(buffer);
    extension = readManifest(JSON.parse(zip.read('extension/package.json').toString('utf8')), 'imported');
  } catch { throw new BranchBraceError('extension-invalid'); }
  if (!extension) throw new BranchBraceError('extension-no-grammar');
  const wanted = new Set(['package.json', ...extension.grammars.map((grammar) => grammar.path), ...extension.languages.map((language) => language.configuration).filter((item): item is string => Boolean(item))]);
  if (!extension.grammars.some((grammar) => zip.has(`extension/${grammar.path}`))) throw new BranchBraceError('extension-no-grammar');
  await mkdir(root, { recursive: true });
  const staging = path.join(root, `.import-${randomUUID()}`);
  // Les versions déjà importées sont mises de côté (dossiers en `.`, ignorés des lectures), pas supprimées : si la
  // nouvelle ne peut pas prendre leur place (rename refusé sous Windows…), elles sont restaurées.
  const aside: { folder: string; parked: string }[] = [];
  try {
    for (const relative of wanted) {
      // Chemins déjà normalisés par readManifest : relativePath ne renvoie pas null ici.
      const name = `extension/${relativePath(relative)}`;
      if (!zip.has(name)) continue;
      const target = path.join(staging, ...relativePath(relative)!.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, zip.read(name));
    }
    for (const folder of await importedFolders(root, extension.id)) {
      const parked = path.join(root, `.replaced-${randomUUID()}`);
      await rename(folder, parked);
      aside.push({ folder, parked });
    }
    await rename(staging, path.join(root, `${safeName(extension.id)}-${safeName(extension.version)}`));
  } catch (error) {
    for (const { folder, parked } of aside.reverse()) await rename(parked, folder).catch(() => {});
    await rm(staging, { recursive: true, force: true });
    throw error instanceof BranchBraceError ? error : new BranchBraceError('extension-invalid');
  }
  for (const { parked } of aside) await rm(parked, { recursive: true, force: true }).catch(() => {});
  return { id: extension.id, name: extension.name, version: extension.version };
}

// Dossiers des versions importées d'une extension.
async function importedFolders(root: string, id: string): Promise<string[]> {
  const folders: string[] = [];
  let entries: Dirent[] = [];
  try { entries = await readdir(root, { withFileTypes: true }); } catch { /* aucun import */ }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const folder = path.join(root, entry.name);
    try {
      if (readManifest(JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8')), 'imported')?.id === id) folders.push(folder);
    } catch { /* dossier sans manifeste lisible */ }
  }
  return folders;
}

// Retire une extension importée (toutes ses versions) ; les extensions de VS Code ne sont jamais touchées.
export async function removeImported(root: string, id: string): Promise<void> {
  const folders = await importedFolders(root, id);
  if (!folders.length) throw new BranchBraceError('extension-not-found');
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
}
