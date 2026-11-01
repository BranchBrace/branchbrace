import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GitService } from '../src/git.js';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git test fixture failed: ${args[0]}`);
  return result.stdout.trim();
}

async function commitFile(repo, file, content, message) {
  await writeFile(path.join(repo, file), content);
  git(repo, 'add', '--', file);
  git(repo, 'commit', '--quiet', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-workbench-merge-'));
  const repo = path.join(root, 'repository');
  await mkdir(repo);
  git(repo, 'init', '--quiet', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await commitFile(repo, 'base.txt', 'initial\n', 'initial');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, repo, service: new GitService(repo) };
}

// Dépôt suivi par un remote bare local, et un second clone qui peut y pousser des commits « venus d'ailleurs ».
async function withRemote(t) {
  const context = await fixture(t);
  const { root, repo } = context;
  const bare = path.join(root, 'remote.git');
  const other = path.join(root, 'other');
  git(root, 'init', '--quiet', '--bare', bare);
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '--quiet', '-u', 'origin', 'main');
  git(root, 'clone', '--quiet', bare, other);
  git(other, 'config', 'user.name', 'Other Writer');
  git(other, 'config', 'user.email', 'other@example.invalid');
  return { ...context, bare, other };
}

const recoveryRefs = (repo) => git(repo, 'for-each-ref', '--format=%(refname)', 'refs/git-workbench/recovery').split('\n').filter(Boolean);

test('merge preview lists incoming commits and a diverged merge creates a merge commit after a recovery point', async (t) => {
  const { repo, service } = await fixture(t);
  git(repo, 'switch', '--quiet', '-c', 'feature');
  await commitFile(repo, 'feature.txt', 'feature\n', 'feature work');
  const featureTip = await commitFile(repo, 'feature.txt', 'feature 2\n', 'more feature work');
  git(repo, 'switch', '--quiet', 'main');
  const before = await commitFile(repo, 'main.txt', 'main\n', 'main work');

  const preview = await service.mergePreview('feature');
  assert.equal(preview.branch, 'main');
  assert.equal(preview.target, featureTip);
  assert.equal(preview.total, 2);
  assert.deepEqual(preview.commits.map((commit) => commit.subject), ['more feature work', 'feature work']);
  assert.equal(preview.fastForward, false);

  const result = await service.merge('feature', { expectedTarget: featureTip });
  assert.match(result.recoveryRef, /^refs\/git-workbench\/recovery\/merge-/);
  assert.equal(git(repo, 'rev-parse', result.recoveryRef), before);
  assert.equal(result.fastForwarded, false);
  assert.equal(git(repo, 'rev-parse', 'HEAD^1'), before);
  assert.equal(git(repo, 'rev-parse', 'HEAD^2'), featureTip);
  assert.equal(git(repo, 'log', '-1', '--format=%s'), "Merge branch 'feature' into main");
  assert.equal(result.status.branch, 'main');
  assert.equal(result.status.files.length, 0);
});

test('merge creates a merge commit by default and fast-forwards only when asked', async (t) => {
  const { repo, service } = await fixture(t);
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '--quiet', '-c', 'feature');
  const featureTip = await commitFile(repo, 'feature.txt', 'feature\n', 'feature work');
  git(repo, 'switch', '--quiet', 'main');
  assert.equal((await service.mergePreview('feature')).fastForward, true);

  const merged = await service.merge('feature');
  assert.equal(merged.fastForwarded, false);
  assert.equal(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);

  git(repo, 'reset', '--quiet', '--hard', base);
  const forwarded = await service.merge('feature', { fastForward: true, expectedTarget: featureTip });
  assert.equal(forwarded.fastForwarded, true);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), featureTip);
  assert.equal(git(repo, 'rev-parse', forwarded.recoveryRef), base);
});

test('merge refuses a stale preview, an empty merge and a dirty tree without saving a recovery point', async (t) => {
  const { repo, service } = await fixture(t);
  git(repo, 'switch', '--quiet', '-c', 'feature');
  await commitFile(repo, 'feature.txt', 'feature\n', 'feature work');
  git(repo, 'switch', '--quiet', 'main');
  const head = git(repo, 'rev-parse', 'HEAD');

  await assert.rejects(service.merge('feature', { expectedTarget: head }), (error) => error.code === 'merge-source-changed');
  await assert.rejects(service.merge('main'), (error) => error.code === 'nothing-to-merge');
  await writeFile(path.join(repo, 'base.txt'), 'local edit\n');
  await assert.rejects(service.merge('feature'), (error) => error.code === 'working-tree-not-clean');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(recoveryRefs(repo), []);
});

test('a merge conflict keeps the recovery point and hands over to conflict resolution', async (t) => {
  const { repo, service } = await fixture(t);
  git(repo, 'switch', '--quiet', '-c', 'feature');
  const featureTip = await commitFile(repo, 'base.txt', 'feature side\n', 'feature edit');
  git(repo, 'switch', '--quiet', 'main');
  const before = await commitFile(repo, 'base.txt', 'main side\n', 'main edit');

  let recoveryRef;
  await assert.rejects(service.merge('feature'), (error) => {
    assert.equal(error.code, 'conflict');
    assert.equal(error.operation, 'merge');
    assert.match(error.recoveryRef, /^refs\/git-workbench\/recovery\/merge-/);
    recoveryRef = error.recoveryRef;
    return true;
  });
  assert.equal(git(repo, 'rev-parse', recoveryRef), before);
  assert.equal(await service.operation(), 'merge');
  const conflict = await service.conflictVersions('base.txt');
  assert.equal(conflict.ours, 'main side\n');
  assert.equal(conflict.theirs, 'feature side\n');

  await service.resolveConflict('base.txt', 'both sides\n');
  const continued = await service.continueOperation();
  assert.equal(continued.operation, 'merge');
  assert.equal(await service.operation(), null);
  assert.equal(git(repo, 'rev-parse', 'HEAD^2'), featureTip);
  assert.equal(git(repo, 'log', '-1', '--format=%s'), "Merge branch 'feature' into main");
});

test('pull fetches the upstream then fast-forwards the current branch', async (t) => {
  const { repo, other, service } = await withRemote(t);
  const before = git(repo, 'rev-parse', 'HEAD');
  const remoteTip = await commitFile(other, 'remote.txt', 'remote\n', 'remote work');
  git(other, 'push', '--quiet');

  const result = await service.pull('origin/main');
  assert.equal(result.pulled, true);
  assert.equal(result.behind, 1);
  assert.equal(result.ahead, 0);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), remoteTip);
  assert.equal(git(repo, 'rev-parse', result.recoveryRef), before);

  const again = await service.pull('origin/main');
  assert.equal(again.pulled, false);
  assert.equal(again.diverged, false);
});

test('a diverged pull integrates nothing and reports how far each side has moved', async (t) => {
  const { repo, other, service } = await withRemote(t);
  const remoteTip = await commitFile(other, 'remote.txt', 'remote\n', 'remote work');
  git(other, 'push', '--quiet');
  const local = await commitFile(repo, 'local.txt', 'local\n', 'local work');

  const result = await service.pull('origin/main');
  assert.deepEqual({ ...result }, { upstream: 'origin/main', ahead: 1, behind: 1, pulled: false, diverged: true, recoveryRef: null });
  assert.equal(git(repo, 'rev-parse', 'HEAD'), local);
  assert.equal(git(repo, 'rev-parse', 'origin/main'), remoteTip);
  assert.deepEqual(recoveryRefs(repo), []);
  // Le fetch fait, l'upstream se prévisualise comme une source de merge ordinaire.
  const preview = await service.mergePreview('origin/main');
  assert.deepEqual(preview.commits.map((commit) => commit.hash), [remoteTip]);
  assert.equal(preview.fastForward, false);
  await service.merge('origin/main', { expectedTarget: remoteTip });
  assert.equal(git(repo, 'log', '-1', '--format=%s'), "Merge remote-tracking branch 'origin/main' into main");
});

test('pull without an upstream, or with a different one, is refused before any network access', async (t) => {
  const { repo, service } = await fixture(t);
  await assert.rejects(service.pull(), (error) => error.code === 'upstream-missing');
  git(repo, 'switch', '--quiet', '--detach');
  await assert.rejects(service.pull(), (error) => error.code === 'upstream-missing');

  const tracked = await withRemote(t);
  await assert.rejects(tracked.service.pull('origin/other'), (error) => error.code === 'upstream-changed');
  assert.deepEqual(recoveryRefs(tracked.repo), []);
});
