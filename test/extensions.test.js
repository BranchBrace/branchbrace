import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { importVsix, readGrammar, readZip, removeImported, scanExtensions } from '../src/extensions.js';
import { buildCatalog, compareExtensionVersions, injectionsFor, languageConfiguration, parseJsonc, pickToken, readManifest, relativePath, resolveLanguage } from '../src/grammar-catalog.js';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const astro = {
  publisher: 'astro-build',
  name: 'astro-vscode',
  displayName: 'Astro',
  version: '2.16.20',
  contributes: {
    languages: [{ id: 'astro', extensions: ['.astro'], aliases: ['Astro'], configuration: './languages/astro-language-configuration.json' }],
    grammars: [
      { language: 'astro', scopeName: 'source.astro', path: './syntaxes/astro.tmLanguage.json', embeddedLanguages: { 'source.css': 'css', 'source.ts': 'typescript' } },
      { scopeName: 'text.html.markdown.astro', path: './syntaxes/markdown.astro.tmLanguage.json', injectTo: ['text.html.markdown', 'source.astro'] },
    ],
  },
};

async function temporary(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'git-workbench-extensions-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function writeExtension(root, folder, packageJson, files = {}) {
  const dir = path.join(root, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(packageJson));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

// Archive zip minimale (entrées compressées en deflate), comme celles que produit `vsce package`.
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name);
    const data = deflateRawSync(Buffer.from(content));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(Buffer.byteLength(content), 22); local.writeUInt16LE(nameBuffer.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(Buffer.byteLength(content), 24); central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuffer, data);
    centrals.push(central, nameBuffer);
    offset += 30 + nameBuffer.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('manifest parsing keeps languages and grammars, and rejects paths leaving the extension folder', () => {
  const extension = readManifest(astro, 'installed');
  assert.equal(extension.id, 'astro-build.astro-vscode');
  assert.equal(extension.name, 'Astro');
  assert.deepEqual(extension.languages[0].extensions, ['.astro']);
  assert.equal(extension.languages[0].configuration, 'languages/astro-language-configuration.json');
  assert.equal(extension.grammars[0].path, 'syntaxes/astro.tmLanguage.json');
  assert.deepEqual(extension.grammars[0].embeddedLanguages, { 'source.css': 'css', 'source.ts': 'typescript' });
  assert.deepEqual(extension.grammars[1].injectTo, ['text.html.markdown', 'source.astro']);

  const hostile = readManifest({ name: 'x', contributes: { grammars: [{ scopeName: 'source.x', path: '../../etc/passwd' }, { scopeName: 'source.y', path: 'C:/Windows/x.json' }] } }, 'imported');
  assert.equal(hostile, null, 'no usable grammar left');
  assert.equal(readManifest({ name: 'theme', contributes: { themes: [] } }, 'installed'), null, 'extensions without grammars are ignored');
  assert.equal(readManifest({ name: 'nls', displayName: '%displayName%', contributes: { grammars: [{ scopeName: 's', path: 'a.json' }] } }, 'builtin').name, 'nls');
  assert.equal(relativePath('./a/./b.json'), 'a/b.json');
  assert.equal(relativePath('/abs.json'), null);
});

test('language configuration is read from JSON with comments and keeps only strings', () => {
  const raw = parseJsonc(`{
    // commentaire
    "comments": { "lineComment": "//", "blockComment": ["/*", "*/"] }, /* bloc */
    "brackets": [["{", "}"], ["(", ")"],],
    "autoClosingPairs": [{ "open": "\\"", "close": "\\"", "notIn": ["string"] }, ["<!--", "-->"], 3],
    "url": "https://example.test/a//b",
  }`);
  assert.equal(raw.url, 'https://example.test/a//b', 'a // inside a string is not a comment');
  assert.deepEqual(languageConfiguration(raw), {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['(', ')']],
    autoClosingPairs: [{ open: '"', close: '"' }, { open: '<!--', close: '-->' }],
    surroundingPairs: [],
  });
});

test('file resolution prefers file names, longer extensions, then imported over installed over builtin', () => {
  const ext = (id, source, languages, grammars) => ({ id, name: id, version: '1.0.0', source, languages, grammars });
  const language = (id, extensions, filenames = []) => ({ id, extensions, filenames, aliases: [], configuration: null });
  const grammar = (scopeName, lang) => ({ scopeName, path: 'g.json', language: lang, injectTo: [], embeddedLanguages: {} });
  const catalog = buildCatalog([
    ext('imported.prisma', 'imported', [language('prisma', ['.prisma'])], [grammar('source.prisma.mine', 'prisma')]),
    ext('vscode.builtin', 'builtin', [language('typescript', ['.ts']), language('dts', ['.d.ts']), language('make', ['.mk'], ['makefile'])], [grammar('source.ts', 'typescript'), grammar('source.dts', 'dts'), grammar('source.makefile', 'make')]),
    ext('prisma.prisma', 'installed', [language('prisma', ['.prisma'])], [grammar('source.prisma', 'prisma')]),
    ext('nogrammar', 'installed', [language('nothing', ['.nothing'])], [grammar('source.other', null)]),
  ]);
  assert.deepEqual(resolveLanguage('db/schema.PRISMA', catalog), { language: 'prisma', scopeName: 'source.prisma.mine' }, 'imported grammar wins');
  assert.deepEqual(resolveLanguage('types/index.d.ts', catalog), { language: 'dts', scopeName: 'source.dts' }, 'longest extension wins');
  assert.equal(resolveLanguage('src/main.ts', catalog).language, 'typescript');
  assert.equal(resolveLanguage('Makefile', catalog).language, 'make', 'exact file name');
  assert.equal(resolveLanguage('src/main.ts', catalog, ['installed', 'imported']), null, 'builtin grammars only when asked');
  assert.equal(resolveLanguage('a.nothing', catalog), null, 'a language without grammar is not colored');
  assert.equal(resolveLanguage('a.unknown', catalog), null);
  assert.deepEqual(catalog.extensions.map((item) => item.source), ['builtin', 'installed', 'installed', 'imported']);
});

test('an installed extension claims files only for the languages whose grammar it brings', () => {
  const ext = (id, source, languages, grammars) => ({ id, name: id, version: '1.0.0', source, languages, grammars });
  const language = (id, extensions) => ({ id, extensions, filenames: [], aliases: [], configuration: null });
  const grammar = (scopeName, lang) => ({ scopeName, path: 'g.json', language: lang, injectTo: [], embeddedLanguages: {} });
  const catalog = buildCatalog([
    ext('vscode.rust', 'builtin', [language('rust', ['.rs'])], [grammar('source.rust', 'rust')]),
    ext('rust-lang.rust-analyzer', 'installed', [language('rust', ['.rs']), language('ra_syntax_tree', ['.rast'])], [grammar('source.ra_syntax_tree', 'ra_syntax_tree')]),
  ]);
  assert.equal(resolveLanguage('src/lib.rs', catalog, ['installed', 'imported']), null, 'the builtin rust grammar stays behind Monarch');
  assert.equal(resolveLanguage('src/lib.rs', catalog, ['builtin']).scopeName, 'source.rust');
  assert.equal(resolveLanguage('tree.rast', catalog, ['installed', 'imported']).scopeName, 'source.ra_syntax_tree');
});

test('injections and token selection follow the theme rules', () => {
  const catalog = buildCatalog([readManifest(astro, 'installed')]);
  assert.deepEqual(injectionsFor('source.astro', catalog), ['text.html.markdown.astro']);
  assert.deepEqual(injectionsFor('source.css', catalog), []);
  const prefixes = ['string', 'comment', 'entity.name.tag'];
  assert.equal(pickToken(['source.astro', 'string.quoted.double.astro', 'punctuation.definition.string.begin.astro'], prefixes), 'tm.string.quoted.double.astro', 'punctuation takes the string color');
  assert.equal(pickToken(['source.astro', 'meta.tag.start.astro', 'entity.name.tag.astro'], prefixes), 'tm.entity.name.tag.astro');
  assert.equal(pickToken(['source.astro', 'stringy.thing'], prefixes), '', 'prefixes match whole segments only');
  assert.equal(compareExtensionVersions('1.10.0', '1.9.3'), 1);
  assert.equal(compareExtensionVersions('2.0.0-insider', '2.0.0'), 0);
});

test('scanning keeps the newest version, skips obsolete folders and reads grammars by scope only', () => temporary(async (root) => {
  const installed = path.join(root, 'extensions');
  const files = { 'syntaxes/astro.tmLanguage.json': '{"scopeName":"source.astro","patterns":[]}', 'syntaxes/markdown.astro.tmLanguage.json': '{}', 'languages/astro-language-configuration.json': '{ "brackets": [["{","}"]], }' };
  await writeExtension(installed, 'astro-build.astro-vscode-2.16.19', { ...astro, version: '2.16.19' }, files);
  await writeExtension(installed, 'astro-build.astro-vscode-2.16.20', astro, files);
  await writeExtension(installed, 'astro-build.astro-vscode-2.17.0', { ...astro, version: '2.17.0' }, files);
  await writeFile(path.join(installed, '.obsolete'), JSON.stringify({ 'astro-build.astro-vscode-2.17.0': true }));
  await writeExtension(installed, 'broken-1.0.0', { name: 'broken', contributes: { grammars: [{ scopeName: 'source.broken', path: 'missing.json' }] } });
  await mkdir(path.join(installed, 'no-manifest'));

  const scan = await scanExtensions([{ dir: installed, source: 'installed' }, { dir: path.join(root, 'absent'), source: 'imported' }]);
  assert.deepEqual(scan.catalog.extensions.map((item) => `${item.id}@${item.version}`), ['astro-build.astro-vscode@2.16.20']);
  assert.deepEqual(scan.catalog.languages.astro.configuration.brackets, [['{', '}']]);
  assert.equal(resolveLanguage('src/pages/index.astro', scan.catalog).scopeName, 'source.astro');
  const grammar = await readGrammar(scan, 'source.astro');
  assert.equal(grammar.path, 'astro.tmLanguage.json');
  assert.match(grammar.content, /source\.astro/);
  await assert.rejects(readGrammar(scan, 'source.broken'), { code: 'grammar-not-found' });
  await assert.rejects(readGrammar(scan, '../package.json'), { code: 'grammar-not-found' });
}));

test('a .vsix is imported with only its grammars, replaces older imports and can be removed', () => temporary(async (root) => {
  const prisma = { publisher: 'Prisma', name: 'prisma', version: '6.0.0', contributes: { languages: [{ id: 'prisma', extensions: ['.prisma'], configuration: './language-configuration.json' }], grammars: [{ language: 'prisma', scopeName: 'source.prisma', path: './syntaxes/prisma.tmLanguage.json' }] } };
  const vsix = (version) => zip({
    '[Content_Types].xml': '<Types/>',
    'extension/package.json': JSON.stringify({ ...prisma, version }),
    'extension/syntaxes/prisma.tmLanguage.json': '{"scopeName":"source.prisma","patterns":[]}',
    'extension/language-configuration.json': '{"comments":{"lineComment":"//"}}',
    'extension/dist/server.js': 'console.log("not needed")',
  });
  await writeFile(path.join(root, 'old.vsix'), vsix('5.0.0'));
  await writeFile(path.join(root, 'new.vsix'), vsix('6.0.0'));
  const target = path.join(root, 'user-data', 'vscode-extensions');

  assert.deepEqual(await importVsix(path.join(root, 'old.vsix'), target), { id: 'prisma.prisma', name: 'prisma', version: '5.0.0' });
  await importVsix(path.join(root, 'new.vsix'), target);
  assert.deepEqual(await readdir(target), ['prisma.prisma-6.0.0']);
  await access(path.join(target, 'prisma.prisma-6.0.0', 'syntaxes', 'prisma.tmLanguage.json'));
  await assert.rejects(access(path.join(target, 'prisma.prisma-6.0.0', 'dist', 'server.js')), 'only manifest, grammars and language configurations are extracted');

  const scan = await scanExtensions([{ dir: target, source: 'imported' }]);
  assert.equal(resolveLanguage('prisma/schema.prisma', scan.catalog).scopeName, 'source.prisma');
  assert.equal(scan.catalog.languages.prisma.configuration.comments.lineComment, '//');

  await removeImported(target, 'prisma.prisma');
  assert.deepEqual(await readdir(target), []);
  await assert.rejects(removeImported(target, 'prisma.prisma'), { code: 'extension-not-found' });
}));

test('an import that cannot take the place of the previous version keeps that version', () => temporary(async (root) => {
  const prisma = (version) => ({ publisher: 'Prisma', name: 'prisma', version, contributes: { languages: [{ id: 'prisma', extensions: ['.prisma'] }], grammars: [{ language: 'prisma', scopeName: 'source.prisma', path: './prisma.json' }] } });
  const vsix = (version) => zip({ 'extension/package.json': JSON.stringify(prisma(version)), 'extension/prisma.json': '{"scopeName":"source.prisma","patterns":[]}' });
  await writeFile(path.join(root, 'old.vsix'), vsix('5.0.0'));
  await writeFile(path.join(root, 'new.vsix'), vsix('6.0.0'));
  const target = path.join(root, 'target');
  await importVsix(path.join(root, 'old.vsix'), target);
  // Un dossier non vide (sans manifeste) occupe la place de la nouvelle version : le rename du dossier extrait échoue.
  await mkdir(path.join(target, 'prisma.prisma-6.0.0'));
  await writeFile(path.join(target, 'prisma.prisma-6.0.0', 'locked.txt'), 'locked');
  await assert.rejects(importVsix(path.join(root, 'new.vsix'), target), { code: 'extension-invalid' });
  assert.deepEqual((await readdir(target)).sort(), ['prisma.prisma-5.0.0', 'prisma.prisma-6.0.0']);
  await access(path.join(target, 'prisma.prisma-5.0.0', 'prisma.json'));
}));

test('archives that are not extensions with grammars are refused', () => temporary(async (root) => {
  await writeFile(path.join(root, 'notzip.vsix'), 'plain text');
  await writeFile(path.join(root, 'theme.vsix'), zip({ 'extension/package.json': JSON.stringify({ name: 'theme', contributes: { themes: [] } }) }));
  await writeFile(path.join(root, 'escape.vsix'), zip({ 'extension/package.json': JSON.stringify({ name: 'evil', contributes: { grammars: [{ scopeName: 's', path: '../../outside.json' }] } }) }));
  const target = path.join(root, 'target');
  await assert.rejects(importVsix(path.join(root, 'notzip.vsix'), target), { code: 'extension-invalid' });
  await assert.rejects(importVsix(path.join(root, 'theme.vsix'), target), { code: 'extension-no-grammar' });
  await assert.rejects(importVsix(path.join(root, 'escape.vsix'), target), { code: 'extension-no-grammar' });
  assert.equal(readZip(zip({ 'a.txt': 'hello' })).read('a.txt').toString(), 'hello');
}));

test('the Oniguruma WebAssembly engine ships with the packaged app and may run under the page CSP', async () => {
  assert.equal(manifest.dependencies['vscode-oniguruma'], manifest.dependencies['vscode-oniguruma'].replace(/^[\^~]/, ''), 'exact version');
  assert.ok(manifest.build.files.includes('node_modules/vscode-oniguruma/release/onig.wasm'));
  assert.ok(manifest.build.files.includes('THIRD_PARTY_NOTICES.md'), 'third-party notices ship with the app');
  const notices = await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  for (const name of ['vscode-textmate', 'vscode-oniguruma', 'Oniguruma — BSD-2-Clause']) assert.ok(notices.includes(name), name);
  assert.ok(manifest.build.files.includes('src/extensions.js') && manifest.build.files.includes('src/grammar-catalog.js'), 'main process modules are packaged');
  await access(createRequire(import.meta.url).resolve('vscode-oniguruma/release/onig.wasm'));
  const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
  assert.match(html, /script-src 'self' 'wasm-unsafe-eval';/);
  assert.match(html, /connect-src 'none'/, 'still no network access from the page');
});
