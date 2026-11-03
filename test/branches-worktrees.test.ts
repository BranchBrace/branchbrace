import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GitService, isInside, parseWorktrees, samePath } from '../src/git.ts';

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git test fixture failed: ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'branchbrace-test-'));
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

// Dépôt avec une branche « feature » poussée sur un dépôt distant local (bare) et qui le suit.
async function withRemote(t: TestContext) {
  const context = await fixture(t);
  const bare = path.join(context.root, 'remote.git');
  git(context.root, 'init', '--quiet', '--bare', bare);
  git(context.repo, 'remote', 'add', 'origin', bare);
  git(context.repo, 'branch', 'feature');
  git(context.repo, 'push', '--quiet', '-u', 'origin', 'feature');
  return { ...context, bare };
}

const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, { code });

test('renaming a local branch keeps its upstream configuration and changes nothing remotely', async (t) => {
  const { repo, bare, service } = await withRemote(t);
  const result = await service.renameBranch('feature', 'feature-renamed');
  assert.deepEqual(result, { branch: 'feature-renamed', remote: null });
  assert.equal(git(repo, 'config', '--get', 'branch.feature-renamed.merge'), 'refs/heads/feature');
  assert.equal(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/feature'), '');
  assert.equal(git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads'), 'refs/heads/feature');
});

test('renaming the current branch keeps it current', async (t) => {
  const { repo, service } = await fixture(t);
  await service.renameBranch('main', 'trunk');
  assert.equal(git(repo, 'branch', '--show-current'), 'trunk');
});

test('a rename onto an existing or invalid name is refused without touching branches', async (t) => {
  const { repo, service } = await fixture(t);
  git(repo, 'branch', 'feature');
  git(repo, 'branch', 'other');
  await rejects(service.renameBranch('feature', 'other'), 'branch-name-taken');
  await rejects(service.renameBranch('feature', 'bad..name'), 'invalid-branch-name');
  await rejects(service.renameBranch('feature', '@{-1}'), 'invalid-branch-name');
  await rejects(service.renameBranch('feature', '-x'), 'invalid-branch-name');
  await rejects(service.renameBranch('missing', 'fresh'), 'branch-not-found');
  assert.deepEqual(git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n'), ['feature', 'main', 'other']);
});

test('renaming the remote branch pushes the new name, tracks it and deletes the old remote name', async (t) => {
  const { repo, bare, service } = await withRemote(t);
  const hash = git(repo, 'rev-parse', 'feature');
  const result = await service.renameBranch('feature', 'topic', { remote: true });
  assert.deepEqual(result.remote, { name: 'origin', from: 'feature', to: 'topic' });
  assert.equal(git(bare, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'), `refs/heads/topic ${hash}`);
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'topic@{upstream}'), 'origin/topic');
  assert.equal(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/feature'), '');
});

test('a remote rename is refused before any change when the branches diverge or the name is taken remotely', async (t) => {
  const { repo, bare, service } = await withRemote(t);
  git(repo, 'switch', '--quiet', 'feature');
  await writeFile(path.join(repo, 'base.txt'), 'ahead\n');
  git(repo, 'commit', '--quiet', '-am', 'not pushed');
  await rejects(service.renameBranch('feature', 'topic', { remote: true }), 'remote-rename-diverged');
  git(repo, 'push', '--quiet', 'origin', 'feature');
  git(repo, 'push', '--quiet', 'origin', 'main:refs/heads/topic');
  await rejects(service.renameBranch('feature', 'topic', { remote: true }), 'branch-name-taken-remote');
  assert.equal(git(repo, 'branch', '--show-current'), 'feature');
  assert.deepEqual(git(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n'), ['feature', 'topic']);
});

test('worktree list parsing reports branch, detached HEAD, lock, prunable and the current worktree', () => {
  const raw = [
    'worktree /repo', 'HEAD aaa', 'branch refs/heads/main', '',
    'worktree /linked one', 'HEAD bbb', 'detached', 'locked moved to usb', '',
    'worktree /gone', 'HEAD ccc', 'branch refs/heads/old', 'prunable gitdir file points to non-existent location', '',
  ].join('\0');
  const [main, linked, gone] = parseWorktrees(raw, '/linked one');
  assert.equal(main.main, true);
  assert.equal(main.branch, 'main');
  assert.equal(main.current, false);
  assert.equal(linked.path, path.resolve('/linked one'));
  assert.equal(linked.detached, true);
  assert.equal(linked.locked, 'moved to usb');
  assert.equal(linked.current, true);
  assert.equal(gone.prunable, 'gitdir file points to non-existent location');
});

test('worktrees are created from an existing or a new branch, listed, then removed and pruned', async (t) => {
  const { root, repo, service } = await fixture(t);
  git(repo, 'branch', 'feature');
  const existing = path.join(root, 'wt-feature');
  const created = path.join(root, 'wt-new');
  assert.deepEqual(await service.addWorktree(existing, { branch: 'feature' }), { path: existing, branch: 'feature' });
  await service.addWorktree(created, { branch: 'topic', newBranch: true });
  const listed = await service.worktrees();
  assert.deepEqual(listed.map((item) => [item.branch, item.main, item.current]), [['main', true, true], ['feature', false, false], ['topic', false, false]]);
  assert.ok(samePath(listed[1].path, existing));
  // La branche extraite ailleurs est signalée et le basculement est refusé avec une explication.
  const { local } = await service.references();
  assert.ok(samePath(local.find((item) => item.name === 'feature')!.worktree!, existing));
  assert.equal(local.find((item) => item.name === 'main')!.worktree, null);
  await rejects(service.switchBranch('feature'), 'branch-in-other-worktree');
  await rejects(service.addWorktree(path.join(root, 'wt-again'), { branch: 'feature' }), 'branch-in-other-worktree');
  await rejects(service.addWorktree(existing, { branch: 'other', newBranch: true }), 'worktree-path-inside-worktree');
  const occupied = path.join(root, 'occupied');
  await mkdir(occupied);
  await writeFile(path.join(occupied, 'file.txt'), 'x\n');
  await rejects(service.addWorktree(occupied, { branch: 'other', newBranch: true }), 'worktree-path-exists');
  await rejects(service.addWorktree('relative', { branch: 'x', newBranch: true }), 'invalid-path');

  const remaining = await service.removeWorktree(existing);
  assert.deepEqual(remaining.map((item) => item.branch), ['main', 'topic']);
  assert.equal(existsSync(existing), false);
  assert.equal(git(repo, 'rev-parse', '--verify', 'refs/heads/feature').length, 40);
  await rejects(service.removeWorktree(repo), 'worktree-main');

  // Un dossier supprimé hors de l'application est seulement oublié.
  await rm(created, { recursive: true, force: true });
  assert.ok((await service.worktrees()).find((item) => item.branch === 'topic')!.prunable);
  assert.deepEqual((await service.removeWorktree(created)).map((item) => item.branch), ['main']);
});

test('a worktree with uncommitted or untracked changes is never removed', async (t) => {
  const { root, repo, service } = await fixture(t);
  const linked = path.join(root, 'wt-dirty');
  await service.addWorktree(linked, { branch: 'dirty', newBranch: true });
  await writeFile(path.join(linked, 'base.txt'), 'local edit\n');
  await rejects(service.removeWorktree(linked), 'worktree-dirty');
  git(linked, 'checkout', '--', 'base.txt');
  await writeFile(path.join(linked, 'untracked.txt'), 'keep me\n');
  await rejects(service.removeWorktree(linked), 'worktree-dirty');
  assert.equal(await readFile(path.join(linked, 'untracked.txt'), 'utf8'), 'keep me\n');
  git(repo, 'worktree', 'lock', linked);
  await rejects(service.removeWorktree(linked), 'worktree-locked');
});

test('a linked worktree opens as its own repository with its own status and operation state', async (t) => {
  const { root, repo, service } = await fixture(t);
  const linked = path.join(root, 'wt-linked');
  await service.addWorktree(linked, { branch: 'side', newBranch: true });
  const opened = new GitService(linked);
  assert.ok(samePath(await opened.verifyRepository(), linked));
  const snapshot = await opened.snapshot();
  assert.equal(snapshot.status.branch, 'side');
  assert.deepEqual(snapshot.refs.worktrees.filter((item) => item.current).map((item) => item.branch), ['side']);
  assert.ok(samePath(snapshot.refs.local.find((item) => item.name === 'main')!.worktree!, repo));
  await rejects(opened.removeWorktree(linked), 'worktree-current');

  // Conflit de merge dans la worktree liée : l'opération en cours y est détectée, pas dans la principale.
  await writeFile(path.join(repo, 'base.txt'), 'main side\n');
  git(repo, 'commit', '--quiet', '-am', 'main change');
  await writeFile(path.join(linked, 'base.txt'), 'linked side\n');
  git(linked, 'commit', '--quiet', '-am', 'linked change');
  spawnSync('git', ['merge', 'main'], { cwd: linked });
  assert.equal(await opened.operation(), 'merge');
  assert.equal((await opened.status()).files.find((file) => file.path === 'base.txt')!.conflicted, true);
  assert.equal(await service.operation(), null);
  await opened.abortOperation();
  assert.equal(await opened.operation(), null);
});

test('worktree list without -z (Git < 2.36) is parsed line by line', () => {
  const raw = ['worktree /repo', 'HEAD aaa', 'branch refs/heads/main', '', 'worktree /linked', 'HEAD bbb', 'detached', 'prunable gone', ''].join('\r\n');
  const [main, linked] = parseWorktrees(raw, '/repo', '\n');
  assert.equal(main.branch, 'main');
  assert.equal(main.current, true);
  assert.equal(linked.path, path.resolve('/linked'));
  assert.equal(linked.prunable, 'gone');
});

const hook = (bare: string, script: string) => writeFile(path.join(bare, 'hooks', 'pre-receive'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });

test('a remote rename whose push fails reports a dedicated code and leaves the local rename in place', async (t) => {
  const { repo, bare, service } = await withRemote(t);
  await hook(bare, 'exit 1');
  await rejects(service.renameBranch('feature', 'topic', { remote: true }), 'remote-rename-publish-failed');
  assert.equal(git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/topic'), 'topic');
  assert.equal(git(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'), 'feature');
});

test('a remote rename whose old name cannot be deleted is a partial success', async (t) => {
  const { repo, bare, service } = await withRemote(t);
  await hook(bare, 'while read old new ref; do [ "$new" = "0000000000000000000000000000000000000000" ] && exit 1; done; exit 0');
  const result = await service.renameBranch('feature', 'topic', { remote: true });
  assert.deepEqual(result, { branch: 'topic', remote: { name: 'origin', from: 'feature', to: 'topic', oldBranchKept: true } });
  assert.deepEqual(git(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n'), ['feature', 'topic']);
  assert.equal(git(repo, 'config', '--get', 'branch.topic.merge'), 'refs/heads/topic');
});

test('a remote rename in a single-branch clone configures the new upstream without its remote-tracking ref', async (t) => {
  const { root, bare } = await withRemote(t);
  const clone = path.join(root, 'single');
  git(root, 'clone', '--quiet', '--single-branch', '--branch', 'feature', bare, clone);
  git(clone, 'config', 'user.name', 'Test Fixture');
  git(clone, 'config', 'user.email', 'fixture@example.invalid');
  const result = await new GitService(clone).renameBranch('feature', 'topic', { remote: true });
  assert.equal(result.remote?.oldBranchKept, undefined);
  assert.equal(git(clone, 'config', '--get', 'branch.topic.remote'), 'origin');
  assert.equal(git(clone, 'config', '--get', 'branch.topic.merge'), 'refs/heads/topic');
  assert.equal(git(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'), 'topic');
});

test('forgetting a missing worktree keeps the metadata of other missing worktrees', async (t) => {
  const { root, service } = await fixture(t);
  const first = path.join(root, 'wt-first');
  const second = path.join(root, 'wt-second');
  await service.addWorktree(first, { branch: 'first', newBranch: true });
  await service.addWorktree(second, { branch: 'second', newBranch: true });
  await rm(first, { recursive: true, force: true });
  await rm(second, { recursive: true, force: true });
  const remaining = await service.removeWorktree(first);
  assert.deepEqual(remaining.map((item) => [item.branch, Boolean(item.prunable)]), [['main', false], ['second', true]]);
});

test('a new worktree inside an existing worktree is refused', async (t) => {
  const { root, repo, service } = await fixture(t);
  await rejects(service.addWorktree(path.join(repo, 'nested'), { branch: 'nested', newBranch: true }), 'worktree-path-inside-worktree');
  const linked = path.join(root, 'wt-linked');
  await service.addWorktree(linked, { branch: 'linked', newBranch: true });
  await rejects(service.addWorktree(path.join(linked, 'deeper'), { branch: 'deeper', newBranch: true }), 'worktree-path-inside-worktree');
  await service.addWorktree(path.join(root, 'wt-linked-sibling'), { branch: 'sibling', newBranch: true });
  assert.equal(isInside(path.join(root, '..x'), root), true);
  assert.equal(isInside(root, path.join(root, 'child')), false);
});
