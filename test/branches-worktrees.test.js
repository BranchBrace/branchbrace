import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GitService } from '../src/git.js';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git test fixture failed: ${args.join(' ')}: ${result.stderr}`);
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

// Dépôt avec une branche « feature » poussée sur un dépôt distant local (bare) et qui le suit.
async function withRemote(t) {
  const context = await fixture(t);
  const bare = path.join(context.root, 'remote.git');
  git(context.root, 'init', '--quiet', '--bare', bare);
  git(context.repo, 'remote', 'add', 'origin', bare);
  git(context.repo, 'branch', 'feature');
  git(context.repo, 'push', '--quiet', '-u', 'origin', 'feature');
  return { ...context, bare };
}

const rejects = (promise, code) => assert.rejects(promise, (error) => error.code === code);

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
