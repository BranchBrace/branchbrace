import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GitService, GitWorkbenchError } from '../src/git.js';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git test fixture failed: ${args[0]}`);
  return result.stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-workbench-test-'));
  const repo = path.join(root, 'repository');
  await mkdir(repo);
  git(repo, 'init', '--quiet', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(repo, 'base.txt'), 'initial\n');
  git(repo, 'add', 'base.txt');
  git(repo, 'commit', '--quiet', '-m', 'initial');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, repo, service: new GitService(repo) };
}

test('repository inspection is read-only and reports untracked and modified files', async (t) => {
  const { repo, service } = await fixture(t);
  const headBefore = git(repo, 'rev-parse', 'HEAD');
  await writeFile(path.join(repo, 'base.txt'), 'changed\n');
  await writeFile(path.join(repo, 'new file.txt'), 'new\n');
  const state = await service.status();
  assert.equal(state.branch, 'main');
  assert.deepEqual(state.files.map((file) => file.path).sort(), ['base.txt', 'new file.txt']);
  assert.equal(state.files.find((file) => file.path === 'new file.txt').untracked, true);
  assert.equal((await service.history())[0].subject, 'initial');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), headBefore);
  assert.equal((await readFile(path.join(repo, 'base.txt'), 'utf8')), 'changed\n');
});

test('renamed paths use the destination path from NUL-delimited Git status', async (t) => {
  const { repo, service } = await fixture(t);
  await writeFile(path.join(repo, 'old name.txt'), 'rename fixture\n');
  git(repo, 'add', '--', 'old name.txt'); git(repo, 'commit', '--quiet', '-m', 'add rename fixture');
  git(repo, 'mv', '--', 'old name.txt', 'new name.txt');
  const status = await service.status();
  assert.deepEqual(status.files.map(({ path: filePath }) => filePath), ['new name.txt']);
  assert.match(await service.diff('new name.txt', true), /rename from old name\.txt/);
});

test('deleted tracked paths remain visible with a deletion diff until explicitly staged', async (t) => {
  const { repo, service } = await fixture(t);
  await rm(path.join(repo, 'base.txt'));
  const entry = (await service.status()).files[0];
  assert.equal(entry.path, 'base.txt');
  assert.equal(entry.worktreeStatus, 'D');
  assert.match(await service.diff('base.txt'), /deleted file mode/);
  assert.equal((await service.status()).files[0].staged, false);
});

test('staging a single path leaves unrelated paths unstaged and preview is the staged diff', async (t) => {
  const { repo, service } = await fixture(t);
  await writeFile(path.join(repo, 'base.txt'), 'selected\n');
  await writeFile(path.join(repo, '-other file.txt'), 'not selected\n');
  const state = await service.status();
  await service.stage('base.txt');
  assert.match(await service.diff('base.txt', true), /selected/);
  const after = await service.status();
  assert.equal(after.files.find((file) => file.path === 'base.txt').staged, true);
  assert.equal(after.files.find((file) => file.path === '-other file.txt').staged, false);
});

test('untracked file preview shows content before staging, including option-like paths', async (t) => {
  const { repo, service } = await fixture(t);
  await writeFile(path.join(repo, '-draft file.txt'), 'visible before staging\n');
  const diff = await service.diff('-draft file.txt');
  assert.match(diff, /visible before staging/);
  assert.equal((await service.status()).files[0].staged, false);
});

test('unstaging preserves working-tree content', async (t) => {
  const { repo, service } = await fixture(t);
  await writeFile(path.join(repo, 'base.txt'), 'changed\n');
  await service.stage('base.txt');
  await service.unstage('base.txt');
  assert.equal((await readFile(path.join(repo, 'base.txt'), 'utf8')), 'changed\n');
  assert.equal((await service.status()).files[0].staged, false);
});

test('commit requires a non-empty message and commits only staged paths', async (t) => {
  const { repo, service } = await fixture(t);
  await assert.rejects(service.commit('  '), (error) => error instanceof GitWorkbenchError && error.code === 'commit-message-required');
  await writeFile(path.join(repo, 'base.txt'), 'included\n');
  await writeFile(path.join(repo, 'other.txt'), 'left out\n');
  await service.stage('base.txt');
  const hash = await service.commit('explicit fixture commit');
  assert.equal(git(repo, 'show', '-s', '--format=%H', hash), hash);
  assert.equal(git(repo, 'show', '--format=', '--name-only', hash), 'base.txt');
  assert.equal((await service.status()).files[0].path, 'other.txt');
});

test('configured pre-commit hooks remain enabled', async (t) => {
  const { repo, service } = await fixture(t);
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\nprintf hook-ran > hook-marker\n');
  await chmod(hook, 0o755);
  await writeFile(path.join(repo, 'base.txt'), 'hooked\n');
  await service.stage('base.txt');
  await service.commit('run configured hook');
  assert.equal(await readFile(path.join(repo, 'hook-marker'), 'utf8'), 'hook-ran');
});

test('branch creation and switching retain local edits; Git refuses unsafe checkout', async (t) => {
  const { repo, service } = await fixture(t);
  await service.createBranch('feature/safe');
  assert.equal((await service.status()).branch, 'feature/safe');
  await service.switchBranch('main');
  await writeFile(path.join(repo, 'base.txt'), 'main change\n');
  git(repo, 'add', 'base.txt'); git(repo, 'commit', '--quiet', '-m', 'main change');
  await service.switchBranch('feature/safe');
  await writeFile(path.join(repo, 'base.txt'), 'conflicting local edit\n');
  await assert.rejects(service.switchBranch('main'), (error) => error.code === 'unsafe-working-tree');
  assert.equal((await readFile(path.join(repo, 'base.txt'), 'utf8')), 'conflicting local edit\n');
});

test('push targets and verifies the configured upstream using a local bare remote', async (t) => {
  const { root, repo, service } = await fixture(t);
  const bare = path.join(root, 'remote.git');
  git(root, 'init', '--quiet', '--bare', bare);
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '--quiet', '-u', 'origin', 'main');
  await writeFile(path.join(repo, 'base.txt'), 'pushed\n');
  await service.stage('base.txt');
  await service.commit('push fixture');
  const result = await service.push();
  assert.equal(result.upstream, 'origin/main');
  assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), result.hash);
});

test('a rejected non-fast-forward push is not reported as success', async (t) => {
  const { root, repo, service } = await fixture(t);
  const bare = path.join(root, 'remote.git');
  const competitor = path.join(root, 'competitor');
  git(root, 'init', '--quiet', '--bare', bare);
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '--quiet', '-u', 'origin', 'main');
  git(root, 'clone', '--quiet', bare, competitor);
  git(competitor, 'config', 'user.name', 'Competing Writer');
  git(competitor, 'config', 'user.email', 'competitor@example.invalid');
  await writeFile(path.join(competitor, 'remote.txt'), 'remote advance\n');
  git(competitor, 'add', 'remote.txt'); git(competitor, 'commit', '--quiet', '-m', 'remote advance');
  git(competitor, 'push', '--quiet');
  await writeFile(path.join(repo, 'base.txt'), 'local advance\n');
  await service.stage('base.txt'); await service.commit('local advance');
  await assert.rejects(service.push('origin/main'), (error) => error.code === 'push-rejected');
  assert.notEqual(git(bare, 'rev-parse', 'refs/heads/main'), git(repo, 'rev-parse', 'HEAD'));
});

test('a lost push acknowledgement after remote acceptance remains indeterminate without changing the local tree', async (t) => {
  const { root, repo, service } = await fixture(t);
  const bare = path.join(root, 'remote.git');
  git(root, 'init', '--quiet', '--bare', bare);
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '--quiet', '-u', 'origin', 'main');
  await writeFile(path.join(repo, 'base.txt'), 'accepted before acknowledgement loss\n');
  await service.stage('base.txt');
  await service.commit('push acknowledgement fixture');
  const localHeadBefore = git(repo, 'rev-parse', 'HEAD');
  const treeBefore = git(repo, 'write-tree');
  const statusBefore = git(repo, 'status', '--porcelain=v1', '-z');
  // Le côté distant accepte réellement le push puis la connexion se termine en échec : Git lance receivepack via
  // son propre sh, ce qui simule la perte d'acquittement sans shim dans le PATH (non exécutable sous Windows).
  git(repo, 'config', 'remote.origin.receivepack', 'accept_then_fail() { git receive-pack "$@"; exit 1; }; accept_then_fail');
  await assert.rejects(service.push('origin/main'), (error) => error.code === 'push-indeterminate');
  assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), localHeadBefore);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), localHeadBefore);
  assert.equal(git(repo, 'write-tree'), treeBefore);
  assert.equal(git(repo, 'status', '--porcelain=v1', '-z'), statusBefore);
});

test('an unreachable remote is reported as indeterminate, never as a verified push', async (t) => {
  const { root, repo, service } = await fixture(t);
  const bare = path.join(root, 'remote.git');
  const unavailable = path.join(root, 'remote.offline');
  git(root, 'init', '--quiet', '--bare', bare);
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '--quiet', '-u', 'origin', 'main');
  await rm(bare, { recursive: true, force: true });
  await mkdir(unavailable);
  await writeFile(path.join(repo, 'base.txt'), 'offline commit\n');
  await service.stage('base.txt'); await service.commit('offline commit');
  await assert.rejects(service.push('origin/main'), (error) => error.code === 'push-indeterminate');
});

test('cherry-pick and rebase save local recovery refs before rewriting history', async (t) => {
  const { repo, service } = await fixture(t);
  const base = git(repo, 'rev-parse', 'HEAD');
  await service.createBranch('side');
  await writeFile(path.join(repo, 'side.txt'), 'side\n');
  git(repo, 'add', 'side.txt'); git(repo, 'commit', '--quiet', '-m', 'side change');
  const sideCommit = git(repo, 'rev-parse', 'HEAD');
  await service.switchBranch('main');
  const picked = await service.cherryPick(sideCommit);
  assert.match(picked.recoveryRef, /^refs\/git-workbench\/recovery\/cherry-pick-/);
  assert.equal(git(repo, 'show', '-s', '--format=%s', 'HEAD'), 'side change');
  const rebased = await service.rebase(base);
  assert.match(rebased.recoveryRef, /^refs\/git-workbench\/recovery\/rebase-/);
});

test('a cherry-pick conflict preserves the pre-operation recovery ref and reports the abort path', async (t) => {
  const { repo, service } = await fixture(t);
  await service.createBranch('side');
  await writeFile(path.join(repo, 'base.txt'), 'side version\n');
  git(repo, 'add', 'base.txt'); git(repo, 'commit', '--quiet', '-m', 'side edit');
  const side = git(repo, 'rev-parse', 'HEAD');
  await service.switchBranch('main');
  await writeFile(path.join(repo, 'base.txt'), 'main version\n');
  git(repo, 'add', 'base.txt'); git(repo, 'commit', '--quiet', '-m', 'main edit');
  const before = git(repo, 'rev-parse', 'HEAD');
  let recoveryRef;
  await assert.rejects(service.cherryPick(side), (error) => {
    assert.equal(error.code, 'conflict');
    assert.match(error.recoveryRef, /^refs\/git-workbench\/recovery\/cherry-pick-/);
    assert.match(error.message, /git cherry-pick --abort/);
    recoveryRef = error.recoveryRef;
    return true;
  });
  assert.equal(git(repo, 'rev-parse', 'HEAD'), before);
  assert.equal(git(repo, 'rev-parse', recoveryRef), before);
  git(repo, 'cherry-pick', '--abort');
});

test('a rebase conflict preserves the pre-operation recovery ref and reports the abort path', async (t) => {
  const { repo, service } = await fixture(t);
  git(repo, 'switch', '--create', 'upstream');
  await writeFile(path.join(repo, 'base.txt'), 'upstream edit\n');
  git(repo, 'commit', '--quiet', '-am', 'upstream edit');
  git(repo, 'switch', 'main');
  await writeFile(path.join(repo, 'base.txt'), 'local edit\n');
  git(repo, 'commit', '--quiet', '-am', 'local edit');
  const before = git(repo, 'rev-parse', 'HEAD');
  let recoveryRef;
  await assert.rejects(service.rebase('upstream'), (error) => {
    assert.equal(error.code, 'conflict');
    assert.match(error.recoveryRef, /^refs\/git-workbench\/recovery\/rebase-/);
    assert.match(error.message, /git rebase --abort/);
    recoveryRef = error.recoveryRef;
    return true;
  });
  assert.equal(git(repo, 'rev-parse', recoveryRef), before);
  git(repo, 'rebase', '--abort');
});

test('interactive rebase applies an explicitly ordered plan and leaves a recovery ref', async (t) => {
  const { repo, service } = await fixture(t);
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'branch', 'upstream');
  await writeFile(path.join(repo, 'first.txt'), 'first\n');
  git(repo, 'add', 'first.txt'); git(repo, 'commit', '--quiet', '-m', 'first');
  const first = git(repo, 'rev-parse', 'HEAD');
  await writeFile(path.join(repo, 'second.txt'), 'second\n');
  git(repo, 'add', 'second.txt'); git(repo, 'commit', '--quiet', '-m', 'second');
  const second = git(repo, 'rev-parse', 'HEAD');
  const result = await service.interactiveRebase('upstream', [{ hash: second, action: 'pick' }, { hash: first, action: 'pick' }]);
  assert.match(result.recoveryRef, /^refs\/git-workbench\/recovery\/interactive-rebase-/);
  assert.equal(git(repo, 'log', '-2', '--format=%s').split('\n').join(','), 'first,second');
  assert.equal((await service.status()).files.length, 0);
});

test('interactive rebase rejects malformed plans before creating a recovery ref', async (t) => {
  const { repo, service } = await fixture(t);
  const base = git(repo, 'rev-parse', 'HEAD');
  await writeFile(path.join(repo, 'one.txt'), 'one\n');
  git(repo, 'add', 'one.txt'); git(repo, 'commit', '--quiet', '-m', 'one');
  const hash = git(repo, 'rev-parse', 'HEAD');
  await assert.rejects(service.interactiveRebase(base, [{ hash, action: 'fixup' }]), (error) => error.code === 'invalid-rebase-plan');
});

test('an inherited GIT_DIR/GIT_WORK_TREE does not redirect operations to another repository', async (t) => {
  const { repo, service } = await fixture(t);
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'git-workbench-test-other-'));
  const other = path.join(otherRoot, 'other-repo');
  await mkdir(other);
  git(other, 'init', '--quiet', '-b', 'other-branch');
  git(other, 'config', 'user.name', 'Other Fixture');
  git(other, 'config', 'user.email', 'other@example.invalid');
  await writeFile(path.join(other, 'file.txt'), 'other\n');
  git(other, 'add', 'file.txt');
  git(other, 'commit', '--quiet', '-m', 'other initial');
  t.after(() => rm(otherRoot, { recursive: true, force: true }));

  const savedGitDir = process.env.GIT_DIR;
  const savedWorkTree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = path.join(other, '.git');
  process.env.GIT_WORK_TREE = other;
  try {
    const status = await service.status();
    assert.equal(status.branch, 'main');
    assert.equal((await service.history())[0].subject, 'initial');
  } finally {
    if (savedGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = savedGitDir;
    if (savedWorkTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = savedWorkTree;
  }
});
