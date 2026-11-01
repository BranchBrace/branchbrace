import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GitService } from '../src/git.js';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git test fixture failed: ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-workbench-recovery-'));
  const repo = path.join(root, 'repository');
  await mkdir(repo);
  git(repo, 'init', '--quiet', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  // Contenus comparés à l'octet près : pas de conversion CRLF, quelle que soit la configuration globale.
  git(repo, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(repo, 'base.txt'), 'initial\n');
  git(repo, 'add', 'base.txt');
  git(repo, 'commit', '--quiet', '-m', 'initial');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, repo, service: new GitService(repo) };
}

const stashList = (repo) => git(repo, 'stash', 'list');
const read = (repo, file) => readFile(path.join(repo, file), 'utf8');

test('a recovery point without the working tree records HEAD and its branch only', async (t) => {
  const { repo, service } = await fixture(t);
  await writeFile(path.join(repo, 'base.txt'), 'local edit\n');
  const point = await service.saveRecoveryPoint('reset');
  assert.match(point.ref, /^refs\/git-workbench\/recovery\/reset-/);
  assert.equal(git(repo, 'rev-parse', point.ref), git(repo, 'rev-parse', 'HEAD'));
  assert.equal(point.branch, 'refs/heads/main');
  assert.deepEqual(point.refs, { 'refs/heads/main': point.head });
  assert.equal(point.worktree, false);
  assert.equal(await read(repo, 'base.txt'), 'local edit\n', 'the working tree is untouched');
  assert.deepEqual((await service.recoveryPoints()).map((item) => item.id), [point.id]);
});

test('a recovery point with the working tree keeps staged, unstaged and untracked changes without using the stash stack', async (t) => {
  const { repo, service } = await fixture(t);
  await writeFile(path.join(repo, 'base.txt'), 'staged\n');
  git(repo, 'add', 'base.txt');
  await writeFile(path.join(repo, 'base.txt'), 'staged then edited\n');
  await writeFile(path.join(repo, 'new [file].txt'), 'untracked\n');
  await writeFile(path.join(repo, '.gitignore'), 'ignored.log\n');
  await writeFile(path.join(repo, 'ignored.log'), 'ignored\n');
  const point = await service.saveRecoveryPoint('reset', { worktree: true });
  assert.equal(point.worktree, true);
  assert.equal(stashList(repo), '', 'the shared stash stack is not touched');
  assert.equal(await read(repo, 'base.txt'), 'staged then edited\n');

  // Une opération destructive : tout est perdu dans l'arbre de travail.
  git(repo, 'reset', '--hard', '--quiet');
  git(repo, 'clean', '-f', '--quiet');
  assert.equal(existsSync(path.join(repo, 'new [file].txt')), false);

  const result = await service.restoreRecoveryPoint(point.id);
  assert.equal(result.restored.id, point.id);
  assert.equal(await read(repo, 'base.txt'), 'staged then edited\n');
  assert.equal(git(repo, 'show', ':base.txt'), 'staged', 'the index is restored too');
  assert.equal(await read(repo, 'new [file].txt'), 'untracked\n');
  assert.equal(await read(repo, 'ignored.log'), 'ignored\n', 'ignored files are left alone');
  assert.equal(stashList(repo), '');
});

test('a clean working tree records no uncommitted changes', async (t) => {
  const { service } = await fixture(t);
  const point = await service.saveRecoveryPoint('reset', { worktree: true });
  assert.equal(point.worktree, false);
});

test('extra refs are recorded and restored, including a deleted branch and an annotated tag', async (t) => {
  const { repo, service } = await fixture(t);
  git(repo, 'branch', 'feature');
  git(repo, 'tag', '-a', 'v1', '-m', 'v1');
  const tagObject = git(repo, 'rev-parse', 'refs/tags/v1');
  const point = await service.saveRecoveryPoint('delete-branch', { refs: ['refs/heads/feature', 'refs/tags/v1'] });
  git(repo, 'branch', '-D', 'feature');
  git(repo, 'tag', '-d', 'v1');
  await service.undo();
  assert.equal(git(repo, 'rev-parse', 'refs/heads/feature'), point.head);
  assert.equal(git(repo, 'rev-parse', 'refs/tags/v1'), tagObject);
  await assert.rejects(service.saveRecoveryPoint('x', { refs: ['refs/remotes/origin/main'] }), { code: 'invalid-recovery-ref' });
  await assert.rejects(service.saveRecoveryPoint('Bad name'), { code: 'invalid-operation' });
});

test('undo and redo of an amend restore each version of the commit and the staged changes', async (t) => {
  const { repo, service } = await fixture(t);
  const original = git(repo, 'rev-parse', 'HEAD');
  await writeFile(path.join(repo, 'base.txt'), 'amended\n');
  git(repo, 'add', 'base.txt');
  const { hash: amended } = await service.amend('initial (amended)');
  assert.equal((await service.undoState()).redo, null);
  assert.equal((await service.undoState()).undo.operation, 'amend');

  const undone = await service.undo();
  assert.equal(undone.restored.operation, 'amend');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), original);
  assert.equal(git(repo, 'branch', '--show-current'), 'main');
  assert.equal(git(repo, 'show', ':base.txt'), 'amended', 'the amended content is staged again, as before the amend');
  assert.equal(await read(repo, 'base.txt'), 'amended\n');
  assert.equal((await service.undoState()).redo.kind, 'undo');

  await service.redo();
  assert.equal(git(repo, 'rev-parse', 'HEAD'), amended);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  const state = await service.undoState();
  assert.equal(state.redo, null);
  assert.equal(state.undo.operation, 'redo', 'a redo can itself be undone');

  await service.undo();
  assert.equal(git(repo, 'rev-parse', 'HEAD'), original);
  assert.equal(stashList(repo), '');
});

test('undo keeps unrelated local edits and refuses when one would be overwritten', async (t) => {
  const { repo, service } = await fixture(t);
  await writeFile(path.join(repo, 'other.txt'), 'other\n');
  git(repo, 'add', 'other.txt');
  git(repo, 'commit', '--quiet', '-m', 'other');
  const before = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '--quiet', '-c', 'topic', 'HEAD~1');
  await writeFile(path.join(repo, 'picked.txt'), 'picked\n');
  git(repo, 'add', 'picked.txt');
  git(repo, 'commit', '--quiet', '-m', 'to pick');
  const picked = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '--quiet', 'main');
  await service.cherryPick(picked);

  await writeFile(path.join(repo, 'picked.txt'), 'edited after the pick\n');
  await assert.rejects(service.undo(), { code: 'unsafe-working-tree' });
  assert.equal((await service.undoState()).redo, null, 'a refused undo leaves no redo point behind');

  await writeFile(path.join(repo, 'picked.txt'), 'picked\n');
  await writeFile(path.join(repo, 'other.txt'), 'unrelated edit\n');
  await service.undo();
  assert.equal(git(repo, 'rev-parse', 'HEAD'), before);
  assert.equal(existsSync(path.join(repo, 'picked.txt')), false);
  assert.equal(await read(repo, 'other.txt'), 'unrelated edit\n');
});

test('a new operation after an undo discards the redo', async (t) => {
  const { repo, service } = await fixture(t);
  await service.amend('first amend');
  await service.undo();
  assert.ok((await service.undoState()).redo);
  await service.amend('second amend');
  assert.equal((await service.undoState()).redo, null);
  await assert.rejects(service.redo(), { code: 'nothing-to-redo' });
  assert.equal(git(repo, 'log', '-1', '--format=%s'), 'second amend');
});

test('undo is refused when it would remove a commit already pushed to the upstream', async (t) => {
  const { root, repo, service } = await fixture(t);
  const bare = path.join(root, 'remote.git');
  git(root, 'init', '--quiet', '--bare', bare);
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '--quiet', '-u', 'origin', 'main');
  const { hash: amended } = await service.amend('amended before push');
  git(repo, 'push', '--quiet', '--force', 'origin', 'main');

  await assert.rejects(service.undo(), { code: 'recovery-would-rewrite-published' });
  assert.equal(git(repo, 'rev-parse', 'HEAD'), amended);
  assert.equal((await service.undoState()).redo, null);
});

test('undoing an amend of a pushed commit is allowed: it brings the published commit back', async (t) => {
  const { root, repo, service } = await fixture(t);
  const bare = path.join(root, 'remote.git');
  git(root, 'init', '--quiet', '--bare', bare);
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '--quiet', '-u', 'origin', 'main');
  const published = git(repo, 'rev-parse', 'HEAD');
  await service.amend('amended after push');
  await service.undo();
  assert.equal(git(repo, 'rev-parse', 'HEAD'), published);
  await assert.rejects(service.redo(), { code: 'recovery-would-rewrite-published' });
});

test('a recovery point taken on another branch is not restored from the current one', async (t) => {
  const { repo, service } = await fixture(t);
  await service.amend('amended on main');
  git(repo, 'switch', '--quiet', '-c', 'elsewhere');
  await assert.rejects(service.undo(), { code: 'recovery-point-other-branch' });
  await assert.rejects(new GitService(repo).redo(), { code: 'nothing-to-redo' });
});

test('recovery points belong to their worktree', async (t) => {
  const { root, repo, service } = await fixture(t);
  const other = path.join(root, 'other-worktree');
  git(repo, 'worktree', 'add', '--quiet', '-b', 'side', other);
  await service.amend('amended in the main worktree');
  const sideService = new GitService(other);
  assert.deepEqual(await sideService.recoveryPoints(), []);
  await assert.rejects(sideService.undo(), { code: 'nothing-to-undo' });
});
