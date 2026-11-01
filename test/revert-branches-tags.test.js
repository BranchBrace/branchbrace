import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GitService } from '../src/git.js';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git test fixture failed: ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

// Dépôt avec un commit initial et un remote bare local « origin » qui a reçu main.
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-workbench-refs-'));
  const repo = path.join(root, 'repository');
  const bare = path.join(root, 'remote.git');
  await mkdir(repo);
  git(root, 'init', '--quiet', '--bare', bare);
  git(repo, 'init', '--quiet', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(repo, 'base.txt'), 'initial\n');
  git(repo, 'add', 'base.txt');
  git(repo, 'commit', '--quiet', '-m', 'initial');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '--quiet', '--set-upstream', 'origin', 'main');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, repo, bare, service: new GitService(repo) };
}

async function commitFile(repo, file, content, message) {
  await writeFile(path.join(repo, file), content);
  git(repo, 'add', '--', file);
  git(repo, 'commit', '--quiet', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

const rejects = (promise, code) => assert.rejects(promise, (error) => error.code === code);

test('revert adds the inverse commit of an already pushed commit without rewriting history', async (t) => {
  const { repo, service } = await fixture(t);
  const target = await commitFile(repo, 'feature.txt', 'feature\n', 'add feature');
  git(repo, 'push', '--quiet');
  await commitFile(repo, 'other.txt', 'other\n', 'other change');
  const before = git(repo, 'rev-parse', 'HEAD');
  const result = await service.revert(target);
  assert.equal(git(repo, 'rev-parse', 'HEAD~1'), before);
  assert.equal(result.hash, git(repo, 'rev-parse', 'HEAD'));
  assert.match(git(repo, 'log', '-1', '--format=%B'), new RegExp(`This reverts commit ${target}`));
  assert.equal(spawnSync('git', ['cat-file', '-e', 'HEAD:feature.txt'], { cwd: repo }).status, 128);
  assert.equal(await readFile(path.join(repo, 'other.txt'), 'utf8'), 'other\n');
  assert.equal(git(repo, 'rev-parse', result.recoveryRef), before);
  assert.equal(result.status.files.length, 0);
  await rejects(service.revert(target, 1), 'revert-mainline-invalid');
});

test('reverting a merge commit requires choosing the kept parent', async (t) => {
  const { repo, service } = await fixture(t);
  git(repo, 'switch', '--quiet', '--create', 'topic');
  await commitFile(repo, 'topic.txt', 'topic\n', 'topic work');
  git(repo, 'switch', '--quiet', 'main');
  await commitFile(repo, 'main.txt', 'main\n', 'main work');
  git(repo, 'merge', '--quiet', '--no-ff', '--no-edit', 'topic');
  const merge = git(repo, 'rev-parse', 'HEAD');
  await rejects(service.revert(merge), 'revert-mainline-required');
  await rejects(service.revert(merge, 3), 'revert-mainline-required');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), merge);
  await service.revert(merge, 1);
  assert.equal(git(repo, 'rev-parse', 'HEAD~1'), merge);
  assert.equal(spawnSync('git', ['cat-file', '-e', 'HEAD:topic.txt'], { cwd: repo }).status, 128);
  assert.equal(git(repo, 'show', 'HEAD:main.txt'), 'main');
});

test('a conflicting revert stops as a revert operation that the conflict flow can continue', async (t) => {
  const { repo, service } = await fixture(t);
  const target = await commitFile(repo, 'base.txt', 'second\n', 'second');
  await commitFile(repo, 'base.txt', 'third\n', 'third');
  await assert.rejects(service.revert(target), (error) => error.code === 'conflict' && error.operation === 'revert' && Boolean(error.recoveryRef));
  assert.equal(await service.operation(), 'revert');
  await service.resolveConflict('base.txt', 'resolved\n');
  const { operation } = await service.continueOperation();
  assert.equal(operation, 'revert');
  assert.equal(await service.operation(), null);
  assert.equal(git(repo, 'show', 'HEAD:base.txt'), 'resolved');
});

test('revert refuses a dirty working tree', async (t) => {
  const { repo, service } = await fixture(t);
  const target = await commitFile(repo, 'feature.txt', 'feature\n', 'add feature');
  await writeFile(path.join(repo, 'base.txt'), 'dirty\n');
  await rejects(service.revert(target), 'working-tree-not-clean');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), target);
});

test('tags are annotated by default, lightweight on request, and never replaced', async (t) => {
  const { repo, service } = await fixture(t);
  const first = git(repo, 'rev-parse', 'HEAD');
  const head = await commitFile(repo, 'next.txt', 'next\n', 'next');
  await rejects(service.createTag('v1.0.0', first), 'tag-message-required');
  const annotated = await service.createTag('v1.0.0', first, { message: 'Première version' });
  assert.equal(annotated.annotated, true);
  assert.equal(git(repo, 'cat-file', '-t', 'refs/tags/v1.0.0'), 'tag');
  assert.equal(git(repo, 'rev-parse', 'v1.0.0^{commit}'), first);
  assert.equal(git(repo, 'tag', '-l', '--format=%(contents:subject)', 'v1.0.0'), 'Première version');
  await service.createTag('light', head, { annotated: false });
  assert.equal(git(repo, 'cat-file', '-t', 'refs/tags/light'), 'commit');
  assert.equal(git(repo, 'rev-parse', 'refs/tags/light'), git(repo, 'rev-parse', 'HEAD'));
  await rejects(service.createTag('v1.0.0', head, { message: 'again' }), 'tag-exists');
  assert.equal(git(repo, 'rev-parse', 'v1.0.0^{commit}'), first);
  await rejects(service.createTag('bad..tag', head, { annotated: false }), 'invalid-tag-name');
  await rejects(service.createTag('-f', head, { annotated: false }), 'invalid-tag-name');
});

test('pushing a tag sends only that tag to the chosen remote', async (t) => {
  const { root, repo, bare, service } = await fixture(t);
  const head = git(repo, 'rev-parse', 'HEAD');
  const second = path.join(root, 'second.git');
  git(root, 'init', '--quiet', '--bare', second);
  git(repo, 'remote', 'add', 'backup', second);
  await service.createTag('v1', head, { message: 'release 1' });
  await service.createTag('v2', head, { annotated: false });
  await service.createTag('wip', head, { message: 'not for sharing' });
  const result = await service.pushTag('v1', 'origin');
  assert.equal(result.hash, git(repo, 'rev-parse', 'refs/tags/v1'));
  assert.equal(git(bare, 'for-each-ref', '--format=%(refname)', 'refs/tags'), 'refs/tags/v1');
  assert.equal(git(bare, 'rev-parse', 'refs/tags/v1'), git(repo, 'rev-parse', 'refs/tags/v1'));
  assert.equal(git(second, 'for-each-ref', '--format=%(refname)', 'refs/tags'), '');
  await service.pushTag('v2', 'backup');
  assert.equal(git(second, 'for-each-ref', '--format=%(refname)', 'refs/tags'), 'refs/tags/v2');
  assert.equal(git(bare, 'for-each-ref', '--format=%(refname)', 'refs/tags'), 'refs/tags/v1');
  await rejects(service.pushTag('v1', 'nowhere'), 'remote-not-found');
  await rejects(service.pushTag('missing', 'origin'), 'tag-not-found');
  await rejects(service.pushTag('v1', '--all'), 'remote-not-found');
});
