import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GitService, redactRemoteUrl, remoteUrlHasCredentials } from '../src/git.js';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git test fixture failed: ${args[0]}`);
  return result.stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-workbench-remotes-'));
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

// Dépôt suivi par un remote bare local, avec un commit déjà poussé sur origin/main.
async function published(t) {
  const context = await fixture(t);
  const bare = path.join(context.root, 'remote.git');
  git(context.root, 'init', '--quiet', '--bare', '-b', 'main', bare);
  git(context.repo, 'remote', 'add', 'origin', bare);
  await writeFile(path.join(context.repo, 'base.txt'), 'published\n');
  git(context.repo, 'commit', '--quiet', '-am', 'published');
  git(context.repo, 'push', '--quiet', '-u', 'origin', 'main');
  return { ...context, bare };
}

const remoteHead = (bare) => git(bare, 'rev-parse', 'refs/heads/main');
const config = (repo) => readFile(path.join(repo, '.git', 'config'), 'utf8');

test('remotes can be added, renamed, re-pointed and removed through the service', async (t) => {
  const { root, repo, service } = await fixture(t);
  const first = path.join(root, 'first.git');
  const second = path.join(root, 'second.git');
  git(root, 'init', '--quiet', '--bare', '-b', 'main', first);
  git(root, 'init', '--quiet', '--bare', '-b', 'main', second);

  assert.deepEqual(await service.addRemote('origin', first), [{ name: 'origin', url: first, credentials: false }]);
  await assert.rejects(service.addRemote('origin', second), (error) => error.code === 'remote-exists');
  await assert.rejects(service.addRemote('-x', second), (error) => error.code === 'invalid-remote-name');
  await assert.rejects(service.addRemote('bad name', second), (error) => error.code === 'invalid-remote-name');
  await assert.rejects(service.addRemote('ok', '--upload-pack=touch pwned'), (error) => error.code === 'invalid-remote-url');
  await assert.rejects(service.addRemote('ok', 'ext::sh -c touch% pwned'), (error) => error.code === 'invalid-remote-url');

  // Le renommage emporte les branches distantes et l'upstream des branches locales.
  git(repo, 'push', '--quiet', '-u', 'origin', 'main');
  await service.renameRemote('origin', 'upstream');
  assert.deepEqual((await service.remotes()).map((item) => item.name), ['upstream']);
  assert.equal((await service.status()).upstream, 'upstream/main');
  await assert.rejects(service.renameRemote('origin', 'other'), (error) => error.code === 'remote-not-found');

  await service.setRemoteUrl('upstream', second);
  assert.equal(git(repo, 'remote', 'get-url', 'upstream'), second);
  await assert.rejects(service.setRemoteUrl('missing', second), (error) => error.code === 'remote-not-found');

  assert.deepEqual(await service.removeRemote('upstream'), []);
  assert.equal(git(repo, 'remote'), '');
  assert.equal(git(repo, 'for-each-ref', 'refs/remotes'), '');
  await assert.rejects(service.removeRemote('upstream'), (error) => error.code === 'remote-not-found');
});

test('remote URLs carrying credentials are refused and never echoed back', async (t) => {
  const { repo, service } = await fixture(t);
  const secrets = [
    'https://user:ghp_secret123@github.com/owner/repo.git',
    'https://ghp_secret123@github.com/owner/repo.git',
    'http://oauth2:glpat-secret123@git.example.org/team/app.git',
    'ssh://git:secret123@git.example.org:2201/team/app.git',
    'git:secret123@github.com:owner/repo.git',
  ];
  for (const url of secrets) {
    await assert.rejects(service.addRemote('origin', url), (error) => error.code === 'remote-url-credentials' && !error.message.includes('secret123'));
  }
  assert.equal(git(repo, 'remote'), '');
  assert.doesNotMatch(await config(repo), /secret123/);

  await service.addRemote('origin', 'git@github.com:owner/repo.git');
  await assert.rejects(service.setRemoteUrl('origin', secrets[1]), (error) => error.code === 'remote-url-credentials');
  assert.equal(git(repo, 'remote', 'get-url', 'origin'), 'git@github.com:owner/repo.git');
  await service.addRemote('mirror', 'ssh://git@git.example.org:2201/team/app.git');

  // Une URL à identifiants déjà configurée hors de l'application est listée sans son secret.
  git(repo, 'remote', 'add', 'legacy', secrets[0]);
  const legacy = (await service.remotes()).find((item) => item.name === 'legacy');
  assert.deepEqual(legacy, { name: 'legacy', url: 'https://github.com/owner/repo.git', credentials: true });
  assert.doesNotMatch(JSON.stringify(await service.references()), /secret123/);
});

test('credential detection keeps SSH user names and strips secrets for display', () => {
  assert.equal(remoteUrlHasCredentials('git@github.com:owner/repo.git'), false);
  assert.equal(remoteUrlHasCredentials('ssh://git@host/repo.git'), false);
  assert.equal(remoteUrlHasCredentials('https://github.com/owner/repo.git'), false);
  assert.equal(remoteUrlHasCredentials('/srv/git/repo.git'), false);
  assert.equal(remoteUrlHasCredentials('C:\\repos\\remote.git'), false);
  assert.equal(remoteUrlHasCredentials('https://token@github.com/owner/repo.git'), true);
  assert.equal(redactRemoteUrl('https://user:token@github.com/owner/repo.git'), 'https://github.com/owner/repo.git');
  assert.equal(redactRemoteUrl('user:token@host:owner/repo.git'), 'host:owner/repo.git');
  assert.equal(redactRemoteUrl('git@github.com:owner/repo.git'), 'git@github.com:owner/repo.git');
});

test('a rejected push after amend stays rejected; the lease-protected force push then replaces the upstream', async (t) => {
  const { repo, bare, service } = await published(t);
  const original = remoteHead(bare);
  await writeFile(path.join(repo, 'base.txt'), 'amended\n');
  git(repo, 'add', 'base.txt');
  const { hash: amended } = await service.amend('published (amended)');

  // Le push normal est refusé et n'est jamais retenté en force : la branche distante ne bouge pas.
  await assert.rejects(service.push('origin/main'), (error) => error.code === 'push-rejected');
  assert.equal(remoteHead(bare), original);

  const preview = await service.forcePushPreview('origin/main');
  assert.equal(preview.lease, original);
  assert.equal(preview.droppedCount, 1);
  assert.deepEqual(preview.dropped.map((commit) => [commit.hash, commit.subject]), [[original, 'published']]);

  await assert.rejects(service.forcePush('origin/other', preview.lease), (error) => error.code === 'upstream-changed');
  const result = await service.forcePush('origin/main', preview.lease);
  assert.equal(result.hash, amended);
  assert.equal(remoteHead(bare), amended);
  assert.equal(git(repo, 'rev-parse', 'refs/remotes/origin/main'), amended);
  // Les commits distants remplacés restent atteignables localement.
  assert.equal(git(repo, 'rev-parse', result.recoveryRef), original);
});

test('the force push lease is refused when the upstream moved since the last fetch', async (t) => {
  const { root, repo, bare, service } = await published(t);
  const competitor = path.join(root, 'competitor');
  git(root, 'clone', '--quiet', bare, competitor);
  git(competitor, 'config', 'user.name', 'Competitor');
  git(competitor, 'config', 'user.email', 'competitor@example.invalid');
  await writeFile(path.join(competitor, 'remote.txt'), 'remote advance\n');
  git(competitor, 'add', 'remote.txt');
  git(competitor, 'commit', '--quiet', '-m', 'remote advance');
  git(competitor, 'push', '--quiet');
  const advanced = remoteHead(bare);

  await writeFile(path.join(repo, 'base.txt'), 'amended\n');
  git(repo, 'add', 'base.txt');
  await service.amend('published (amended)');
  const preview = await service.forcePushPreview('origin/main');
  assert.notEqual(preview.lease, advanced);

  await assert.rejects(service.forcePush('origin/main', preview.lease), (error) => error.code === 'force-push-stale' && !error.recoveryRef);
  assert.equal(remoteHead(bare), advanced);
  assert.equal(git(repo, 'for-each-ref', 'refs/git-workbench/recovery/force-push-*'), '');

  // Après un fetch, le nouvel aperçu montre le commit distant que le push forcé ferait disparaître.
  await service.fetch();
  const refreshed = await service.forcePushPreview('origin/main');
  assert.equal(refreshed.lease, advanced);
  assert.ok(refreshed.dropped.some((commit) => commit.subject === 'remote advance'));
});

test('force push requires a configured upstream and an explicit lease', async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(service.forcePushPreview('origin/main'), (error) => error.code === 'upstream-missing');
  await assert.rejects(service.forcePushPreview(null), (error) => error.code === 'upstream-missing');
  await assert.rejects(service.forcePush('origin/main', 'HEAD'), (error) => error.code === 'invalid-revision');
});
