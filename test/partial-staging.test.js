import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GitService, BranchBraceError } from '../src/git.js';

// Indexation partielle (A3) : chaque test part d'un dépôt réel, choisit des lignes comme le ferait la vue de diff
// Monaco, puis vérifie octet par octet le contenu de l'index, l'absence de tout autre changement indexé et
// l'arbre de travail inchangé (A11).

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'latin1' });
  if (result.status !== 0) throw new Error(`git test fixture failed: ${args.join(' ')}\n${result.stderr}`);
  return result.stdout;
}

async function fixture(t, files, { autocrlf = 'false' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'branchbrace-partial-'));
  const repo = path.join(root, 'repository');
  await mkdir(repo);
  git(repo, 'init', '--quiet', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'core.autocrlf', autocrlf);
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(repo, name), content, 'latin1');
  git(repo, 'add', '--all');
  git(repo, 'commit', '--quiet', '-m', 'initial');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { repo, service: new GitService(repo), write: (name, content) => writeFile(path.join(repo, name), content, 'latin1') };
}

// Découpage et blocs de changement comme Monaco : lignes coupées sur \r\n, \r ou \n, alignement par plus longue
// sous-séquence commune ; un bloc vide d'un côté commence à la ligne qui suit l'emplacement.
const monacoLines = (text) => text.split(/\r\n|\r|\n/);
function lineChanges(original, modified) {
  const a = monacoLines(original);
  const b = monacoLines(modified);
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const changes = [];
  let i = 0;
  let j = 0;
  let open = null;
  const close = () => { if (open) { changes.push({ ...open, originalCount: i + 1 - open.originalStart, modifiedCount: j + 1 - open.modifiedStart }); open = null; } };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { close(); i += 1; j += 1; continue; }
    open ??= { originalStart: i + 1, modifiedStart: j + 1 };
    if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) j += 1;
    else i += 1;
  }
  close();
  return changes;
}

// Le diff tel que la vue l'affiche (workingVersions) et la requête envoyée pour les lignes choisies.
async function view(service, filePath, staged = false) {
  const { original, modified } = await service.workingVersions(filePath, staged);
  const changes = lineChanges(original, modified);
  return {
    changes,
    request: (selection) => ({ original, modified, changes, selection: { original: [], modified: [], ...selection } }),
    hunk: (index) => {
      const change = changes[index];
      const range = (start, count) => Array.from({ length: count }, (_, k) => start + k);
      return { original, modified, changes, selection: { original: range(change.originalStart, change.originalCount), modified: range(change.modifiedStart, change.modifiedCount) } };
    },
  };
}

const indexed = (repo, name) => git(repo, 'cat-file', 'blob', `:${name}`);
const stagedNames = (repo) => git(repo, 'diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean).sort();

const numbered = (count, mapper = (n) => `ligne ${n}`) => Array.from({ length: count }, (_, k) => `${mapper(k + 1)}\n`).join('');

test('staging one hunk among several stages that hunk only, nothing else, and leaves the working tree alone', async (t) => {
  const base = numbered(20);
  const { repo, service, write } = await fixture(t, { 'file.txt': base, 'other.txt': 'autre\n' });
  const working = base.replace('ligne 2\n', 'ligne deux\n').replace('ligne 15\n', 'ligne quinze\n');
  await write('file.txt', working);
  await write('other.txt', 'autre modifié\n');
  await write('untracked.txt', 'non suivi\n');
  const diff = await view(service, 'file.txt');
  assert.equal(diff.changes.length, 2);
  await service.stageLines('file.txt', diff.hunk(0));
  assert.equal(indexed(repo, 'file.txt'), base.replace('ligne 2\n', 'ligne deux\n'));
  assert.deepEqual(stagedNames(repo), ['file.txt']);
  assert.match(git(repo, 'diff', '--cached'), /^-ligne 2\n\+ligne deux$/m);
  assert.doesNotMatch(git(repo, 'diff', '--cached'), /quinze/);
  assert.equal(await readFile(path.join(repo, 'file.txt'), 'latin1'), working);
  assert.equal(await readFile(path.join(repo, 'other.txt'), 'latin1'), 'autre modifié\n');
  // Le second bloc reste à indexer : l'indexer à son tour donne exactement le fichier de travail.
  const rest = await view(service, 'file.txt');
  assert.equal(rest.changes.length, 1);
  await service.stageLines('file.txt', rest.hunk(0));
  assert.equal(indexed(repo, 'file.txt'), working);
  assert.equal((await service.status()).files.find((file) => file.path === 'file.txt').unstaged, false);
});

test('staging one added line out of a block stages that line only', async (t) => {
  const { repo, service, write } = await fixture(t, { 'file.txt': 'a\nb\nc\n' });
  await write('file.txt', 'a\nb\nx\ny\nz\nc\n');
  const diff = await view(service, 'file.txt');
  await service.stageLines('file.txt', diff.request({ modified: [4] }));
  assert.equal(indexed(repo, 'file.txt'), 'a\nb\ny\nc\n');
  assert.equal(await readFile(path.join(repo, 'file.txt'), 'latin1'), 'a\nb\nx\ny\nz\nc\n');
});

test('staging one removed line out of a block stages that removal only', async (t) => {
  const { repo, service, write } = await fixture(t, { 'file.txt': 'a\nb\nc\nd\ne\n' });
  await write('file.txt', 'a\ne\n');
  const diff = await view(service, 'file.txt');
  await service.stageLines('file.txt', diff.request({ original: [3] }));
  assert.equal(indexed(repo, 'file.txt'), 'a\nb\nd\ne\n');
  assert.deepEqual(stagedNames(repo), ['file.txt']);
});

test('a replaced line can be staged as its removal plus its addition, the rest of the block untouched', async (t) => {
  const { repo, service, write } = await fixture(t, { 'file.txt': 'a\nb\nc\nd\n' });
  await write('file.txt', 'a\nB\nC\nd\n');
  const diff = await view(service, 'file.txt');
  await service.stageLines('file.txt', diff.request({ original: [3], modified: [3] }));
  assert.equal(indexed(repo, 'file.txt'), 'a\nb\nC\nd\n');
});

test('files without a final newline: appended lines, the end-of-file change and middle lines', async (t) => {
  const { repo, service, write } = await fixture(t, { 'tail.txt': 'a\nb', 'eof.txt': 'a\nb\n', 'mid.txt': 'a\nb\nc' });
  // Ajout après une dernière ligne sans retour à la ligne.
  await write('tail.txt', 'a\nb\nc\nd');
  let diff = await view(service, 'tail.txt');
  await service.stageLines('tail.txt', diff.request({ modified: [3] }));
  assert.equal(indexed(repo, 'tail.txt'), 'a\nb\nc\n');
  diff = await view(service, 'tail.txt');
  await service.stageLines('tail.txt', diff.hunk(0));
  assert.equal(indexed(repo, 'tail.txt'), 'a\nb\nc\nd');
  // Retrait du retour à la ligne final : il se choisit comme la ligne vide finale de Monaco.
  await write('eof.txt', 'A\nb');
  diff = await view(service, 'eof.txt');
  assert.equal(diff.changes.length, 2);
  await service.stageLines('eof.txt', diff.hunk(0));
  assert.equal(indexed(repo, 'eof.txt'), 'A\nb\n');
  diff = await view(service, 'eof.txt');
  await service.stageLines('eof.txt', diff.hunk(0));
  assert.equal(indexed(repo, 'eof.txt'), 'A\nb');
  // Une ligne du milieu, la fin sans retour à la ligne restant inchangée.
  await write('mid.txt', 'a\nB\nc');
  diff = await view(service, 'mid.txt');
  await service.stageLines('mid.txt', diff.hunk(0));
  assert.equal(indexed(repo, 'mid.txt'), 'a\nB\nc');
  assert.equal(await readFile(path.join(repo, 'tail.txt'), 'latin1'), 'a\nb\nc\nd');
});

test('CRLF files keep their exact line endings in the index', async (t) => {
  const { repo, service, write } = await fixture(t, { 'crlf.txt': 'a\r\nb\r\nc\r\nd\r\n' });
  await write('crlf.txt', 'a\r\nx\r\nb\r\nc\r\ny\r\nd\r\n');
  const diff = await view(service, 'crlf.txt');
  await service.stageLines('crlf.txt', diff.hunk(1));
  assert.equal(indexed(repo, 'crlf.txt'), 'a\r\nb\r\nc\r\ny\r\nd\r\n');
  assert.equal(await readFile(path.join(repo, 'crlf.txt'), 'latin1'), 'a\r\nx\r\nb\r\nc\r\ny\r\nd\r\n');
});

test('with core.autocrlf the index receives LF lines while the working file keeps CRLF', async (t) => {
  const { repo, service, write } = await fixture(t, { 'file.txt': 'a\nb\nc\n' }, { autocrlf: 'true' });
  await write('file.txt', 'a\r\nx\r\nb\r\nc\r\ny\r\n');
  const diff = await view(service, 'file.txt');
  assert.equal(diff.changes.length, 2);
  await service.stageLines('file.txt', diff.hunk(0));
  assert.equal(indexed(repo, 'file.txt'), 'a\nx\nb\nc\n');
  assert.equal(await readFile(path.join(repo, 'file.txt'), 'latin1'), 'a\r\nx\r\nb\r\nc\r\ny\r\n');
});

test('partial unstaging reverses only the chosen hunk or line', async (t) => {
  const base = numbered(20);
  const { repo, service, write } = await fixture(t, { 'file.txt': base, 'other.txt': 'autre\n' });
  const working = base.replace('ligne 2\n', 'ligne deux\nligne deux bis\n').replace('ligne 15\n', 'ligne quinze\n');
  await write('file.txt', working);
  await write('other.txt', 'autre indexé\n');
  await service.stage('file.txt');
  await service.stage('other.txt');
  let diff = await view(service, 'file.txt', true);
  assert.equal(diff.changes.length, 2);
  await service.unstageLines('file.txt', diff.hunk(1));
  assert.equal(indexed(repo, 'file.txt'), base.replace('ligne 2\n', 'ligne deux\nligne deux bis\n'));
  assert.equal(indexed(repo, 'other.txt'), 'autre indexé\n');
  diff = await view(service, 'file.txt', true);
  await service.unstageLines('file.txt', diff.request({ modified: [3] }));
  assert.equal(indexed(repo, 'file.txt'), base.replace('ligne 2\n', 'ligne deux\n'));
  assert.deepEqual(stagedNames(repo), ['file.txt', 'other.txt']);
  assert.equal(await readFile(path.join(repo, 'file.txt'), 'latin1'), working);
});

test('new and deleted files can be staged and unstaged line by line', async (t) => {
  const { repo, service, write } = await fixture(t, { 'gone.txt': 'a\nb\nc\n' });
  await write('new file.txt', 'un\ndeux\ntrois\n');
  let diff = await view(service, 'new file.txt');
  await service.stageLines('new file.txt', diff.request({ modified: [1, 3] }));
  assert.equal(indexed(repo, 'new file.txt'), 'un\ntrois\n');
  // Désindexer tout ce qui est indexé d'un fichier nouveau le rend de nouveau non suivi.
  diff = await view(service, 'new file.txt', true);
  await service.unstageLines('new file.txt', diff.hunk(0));
  assert.equal((await service.status()).files.find((file) => file.path === 'new file.txt').untracked, true);

  await rm(path.join(repo, 'gone.txt'));
  diff = await view(service, 'gone.txt');
  await service.stageLines('gone.txt', diff.request({ original: [2] }));
  assert.equal(indexed(repo, 'gone.txt'), 'a\nc\n');
  diff = await view(service, 'gone.txt');
  await service.stageLines('gone.txt', diff.hunk(0));
  assert.equal(git(repo, 'ls-files', '--', 'gone.txt'), '');
  assert.equal((await service.status()).files.find((file) => file.path === 'gone.txt').indexStatus, 'D');
  // Désindexer une partie de la suppression recrée l'entrée d'index avec les seules lignes choisies.
  diff = await view(service, 'gone.txt', true);
  await service.unstageLines('gone.txt', diff.request({ original: [1] }));
  assert.equal(indexed(repo, 'gone.txt'), 'a\n');
});

test('non-ASCII bytes and paths survive the patch unchanged', async (t) => {
  // Contenu en Latin-1 (octets invalides en UTF-8) et nom de fichier accentué avec une espace.
  const name = 'été #2.txt';
  const { repo, service, write } = await fixture(t, { [name]: 'caf\xe9\nna\xefve\n' });
  await write(name, 'caf\xe9\nnouveau\nna\xefve\n');
  const diff = await view(service, name);
  await service.stageLines(name, diff.hunk(0));
  assert.equal(indexed(repo, name), 'caf\xe9\nnouveau\nna\xefve\n');
});

test('an outdated or empty selection is refused and the index stays byte-identical', async (t) => {
  const { repo, service, write } = await fixture(t, { 'file.txt': 'a\nb\nc\n' });
  await write('file.txt', 'a\nB\nc\n');
  const diff = await view(service, 'file.txt');
  const indexBefore = await readFile(path.join(repo, '.git', 'index'));
  await assert.rejects(service.stageLines('file.txt', diff.request({})), (error) => error instanceof BranchBraceError && error.code === 'nothing-selected');
  await write('file.txt', 'a\nB\nc\nd\n');
  await assert.rejects(service.stageLines('file.txt', diff.hunk(0)), (error) => error.code === 'diff-outdated');
  const lying = { ...diff.hunk(0), changes: [{ originalStart: 1, originalCount: 1, modifiedStart: 1, modifiedCount: 1 }], modified: 'a\nB\nc\nd\n' };
  await assert.rejects(service.stageLines('file.txt', lying), (error) => error.code === 'diff-outdated');
  assert.deepEqual(await readFile(path.join(repo, '.git', 'index')), indexBefore);
});

test('a rejected apply leaves the index untouched', async (t) => {
  const { repo, service, write } = await fixture(t, { 'file.txt': 'a\nb\nc\n' });
  await write('file.txt', 'a\nB\nc\n');
  const diff = await view(service, 'file.txt');
  const indexBefore = await readFile(path.join(repo, '.git', 'index'));
  // Un index verrouillé (autre processus Git en cours) : `git apply --cached` refuse, rien n'est écrit.
  await writeFile(path.join(repo, '.git', 'index.lock'), '');
  await assert.rejects(service.stageLines('file.txt', diff.hunk(0)), (error) => error.code === 'partial-apply-failed');
  await rm(path.join(repo, '.git', 'index.lock'));
  assert.deepEqual(await readFile(path.join(repo, '.git', 'index')), indexBefore);
  assert.deepEqual(stagedNames(repo), []);
});

test('renamed and conflicted paths are refused for partial staging', async (t) => {
  const { repo, service } = await fixture(t, { 'old.txt': 'a\n' });
  git(repo, 'mv', 'old.txt', 'new.txt');
  const { original, modified } = await service.workingVersions('new.txt', true);
  await assert.rejects(service.unstageLines('new.txt', { original, modified, changes: [], selection: {} }), (error) => error.code === 'partial-staging-unsupported');
});
