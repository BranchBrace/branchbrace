import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildCatalog } from '../src/grammar-catalog.js';
import { applyCatalog, fallbackLanguage, fileLanguage, grammarCatalog, loadCatalog, setFallback } from '../src/textmate.js';

// Monaco réduit à ce que textmate.js en utilise ; les grammaires Monarch connues sont celles de `monarch`.
const monarch = (name) => ({ rs: 'rust', ts: 'typescript' })[name.split('.').pop()] ?? null;

function fakeMonaco() {
  const factories = new Map();
  const registered = [];
  const models = [];
  return {
    factories,
    models,
    languages: {
      getLanguages: () => [{ id: 'rust', extensions: ['.rs'] }, { id: 'typescript', extensions: ['.ts'] }, ...registered],
      register: (language) => registered.push(language),
      setLanguageConfiguration: () => ({ dispose() {} }),
      registerTokensProviderFactory: (id, factory) => {
        factories.set(id, factory);
        return { dispose: () => { if (factories.get(id) === factory) factories.delete(id); } };
      },
    },
    editor: {
      getModels: () => models,
      setModelLanguage: (model, id) => { model.language = id; },
    },
  };
}

const model = (language) => ({ language, getLanguageId() { return this.language; } });

const ext = (id, source, languages, grammars) => ({ id, name: id, version: '1.0.0', source, languages, grammars });
const language = (id, extensions) => ({ id, extensions, filenames: [], aliases: [], configuration: null });
const grammar = (scopeName, lang) => ({ scopeName, path: 'g.json', language: lang, injectTo: [], embeddedLanguages: {} });

const catalog = buildCatalog([
  ext('vscode.builtin', 'builtin', [language('typescript', ['.ts']), language('astro', ['.astro']), language('rust', ['.rs'])], [grammar('source.ts', 'typescript'), grammar('source.astro', 'astro'), grammar('source.rust', 'rust')]),
  ext('prisma.prisma', 'installed', [language('prisma', ['.prisma'])], [grammar('source.prisma', 'prisma')]),
  ext('local.huge', 'installed', [language('huge', ['.huge', '.rs'])], [grammar('source.huge', 'huge')]),
  // rust-analyzer déclare le langage rust (et ses .rs) sans en fournir la grammaire.
  ext('rust-lang.rust-analyzer', 'installed', [language('rust', ['.rs']), language('ra_syntax_tree', ['.rast'])], [grammar('source.ra_syntax_tree', 'ra_syntax_tree')]),
]);

const grammars = {
  'source.prisma': '{"scopeName":"source.prisma","patterns":[{"match":"\\\\bmodel\\\\b","name":"keyword.other.prisma"}]}',
  'source.ts': '{"scopeName":"source.ts","patterns":[]}',
  'source.astro': '{"scopeName":"source.astro","patterns":[]}',
  'source.rust': '{"scopeName":"source.rust","patterns":[]}',
  'source.ra_syntax_tree': '{"scopeName":"source.ra_syntax_tree","patterns":[]}',
};
const wasm = await readFile(new URL('../node_modules/vscode-oniguruma/release/onig.wasm', import.meta.url));
let onigAvailable = true;
globalThis.window = {
  workbench: {
    onigWasm: async () => { if (!onigAvailable) throw new Error('onig.wasm absent'); return new Uint8Array(wasm); },
    // Une grammaire de plus de 10 Mo est refusée par le processus principal, comme ici `source.huge`.
    readGrammar: async (scopeName) => {
      if (!grammars[scopeName]) throw new Error('grammar-not-found');
      return { path: `${scopeName}.json`, content: grammars[scopeName] };
    },
  },
};
setFallback((id) => fallbackLanguage(id, monarch));

test('a slow grammar catalog does not hold the first diff and is applied when it arrives', async () => {
  const monaco = fakeMonaco();
  let deliver;
  await loadCatalog(monaco, () => new Promise((resolve) => { deliver = resolve; }), 10);
  assert.equal(grammarCatalog(), null, 'Monarch alone after the timeout');
  deliver(catalog);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(grammarCatalog(), catalog);
  await loadCatalog(monaco, () => { throw new Error('ipc'); }, 10);
  assert.equal(grammarCatalog(), catalog, 'a failed request leaves the current catalog');
});

test('installed grammars win over Monarch, which wins over the grammars bundled with VS Code', () => {
  applyCatalog(fakeMonaco(), catalog);
  assert.equal(fileLanguage('schema.prisma', monarch), 'tm.prisma', 'installed extension');
  assert.equal(fileLanguage('main.ts', monarch), 'typescript', 'Monarch before the builtin grammar');
  assert.equal(fileLanguage('page.astro', monarch), 'tm.astro', 'builtin grammar when Monarch does not know the file');
  assert.equal(fileLanguage('notes.txt', monarch), 'plaintext');
  assert.equal(fileLanguage('data.huge', monarch), 'tm.huge');
});

test('a language declared by an installed extension without its grammar keeps Monarch', () => {
  applyCatalog(fakeMonaco(), buildCatalog([
    ext('vscode.builtin', 'builtin', [language('rust', ['.rs'])], [grammar('source.rust', 'rust')]),
    ext('rust-lang.rust-analyzer', 'installed', [language('rust', ['.rs']), language('ra_syntax_tree', ['.rast'])], [grammar('source.ra_syntax_tree', 'ra_syntax_tree')]),
  ]));
  assert.equal(fileLanguage('src/lib.rs', monarch), 'rust');
  assert.equal(fileLanguage('tree.rast', monarch), 'tm.ra_syntax_tree');
});

// Avant tout chargement réussi : vscode-oniguruma garde ensuite son moteur pour tout le processus.
test('a missing Oniguruma engine falls back to Monarch and is retried for the next file', async () => {
  const monaco = fakeMonaco();
  applyCatalog(monaco, catalog);
  const open = model('tm.prisma');
  monaco.models.push(open);
  onigAvailable = false;
  assert.equal(await monaco.factories.get('tm.prisma').create(), null);
  assert.equal(open.language, 'plaintext', 'no Monarch language covers .prisma');
  assert.equal(fileLanguage('schema.prisma', monarch), 'tm.prisma', 'the failure is not cached');

  onigAvailable = true;
  const provider = await monaco.factories.get('tm.prisma').create();
  assert.ok(provider, 'the engine is loaded on the next attempt');
  const { tokens } = provider.tokenize('model User {}', provider.getInitialState());
  assert.equal(tokens[0].scopes, 'tm.keyword.other.prisma');
});

test('a grammar that fails to load hands its files back to Monarch until the next catalog', async () => {
  const monaco = fakeMonaco();
  applyCatalog(monaco, catalog);
  const open = model('tm.huge');
  monaco.models.push(open);
  const factory = monaco.factories.get('tm.huge');
  assert.equal(await factory.create(), null);
  assert.equal(open.language, 'rust', 'the open file falls back to the Monarch language of the extensions it claims');
  assert.notEqual(monaco.factories.get('tm.huge'), factory, 'the factory is registered again');
  assert.equal(fileLanguage('data.rs', monarch), 'rust');
  assert.equal(fileLanguage('data.huge', monarch), 'plaintext');
  applyCatalog(monaco, catalog);
  assert.equal(fileLanguage('data.huge', monarch), 'tm.huge', 'a new catalog tries the grammar again');
});
