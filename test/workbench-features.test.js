import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GitService, remoteWebUrl } from '../src/git.js';
import { conflictCount, parseConflicts, resolveAll, resolveBlock } from '../src/conflicts.js';
import { formatHeader, knownScopes, parseHeader, withBreakingFooter } from '../src/conventional.js';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git test fixture failed: ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-workbench-features-'));
  const repo = path.join(root, 'repository');
  await mkdir(repo);
  git(repo, 'init', '--quiet', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(repo, 'base.txt'), 'initial\n');
  git(repo, 'add', 'base.txt');
  git(repo, 'commit', '--quiet', '-m', 'initial');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, repo, service: new GitService(repo) };
}

async function commitFile(repo, name, content, message) {
  await writeFile(path.join(repo, name), content);
  git(repo, 'add', name);
  git(repo, 'commit', '--quiet', '-m', message);
}

// main et side modifient la même ligne : le cherry-pick de side sur main s'arrête en conflit.
async function conflicted(t) {
  const context = await fixture(t);
  const { repo, service } = context;
  git(repo, 'switch', '--quiet', '--create', 'side');
  await commitFile(repo, 'base.txt', 'side version\n', 'side edit');
  const side = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '--quiet', 'main');
  await commitFile(repo, 'base.txt', 'main version\n', 'main edit');
  await assert.rejects(service.cherryPick(side), (error) => error.code === 'conflict');
  return context;
}

test('remote web URLs drop credentials and recognise GitHub', () => {
  assert.deepEqual(remoteWebUrl('git@github.com:owner/repo.git'), { host: 'github.com', path: 'owner/repo', provider: 'github', web: 'https://github.com/owner/repo' });
  assert.equal(remoteWebUrl('https://user:ghp_secret@github.com/owner/repo.git').web, 'https://github.com/owner/repo');
  assert.equal(remoteWebUrl('ssh://git@git.example.org:2201/team/app.git').provider, 'git');
  assert.equal(remoteWebUrl('/srv/git/repo.git'), null);
  assert.equal(remoteWebUrl('file:///srv/git/repo.git'), null);
});

test('references report tracked, local-only and remote-only branches with their remote page', async (t) => {
  const { root, repo, service } = await fixture(t);
  const bare = path.join(root, 'remote.git');
  git(root, 'init', '--quiet', '--bare', bare);
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '--quiet', '-u', 'origin', 'main');
  git(repo, 'push', '--quiet', 'origin', 'main:refs/heads/remote-only');
  git(repo, 'branch', 'local-only');
  git(repo, 'fetch', '--quiet', 'origin');
  const refs = await service.references();
  assert.equal(refs.remote.find((ref) => ref.name === 'origin/main').trackedBy, 'main');
  const remoteOnly = refs.remote.find((ref) => ref.name === 'origin/remote-only');
  assert.deepEqual([remoteOnly.remote, remoteOnly.branch, remoteOnly.trackedBy], ['origin', 'remote-only', null]);
  assert.equal(refs.local.find((ref) => ref.name === 'local-only').upstream, null);
  assert.deepEqual(refs.remotes.map((remote) => remote.name), ['origin']);
  assert.equal(JSON.stringify(refs).includes(bare.replaceAll('\\', '\\\\')), false, 'raw remote URLs never leave the service');

  await service.checkoutRemote('origin/remote-only');
  assert.equal(git(repo, 'branch', '--show-current'), 'remote-only');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/remote-only');
  await assert.rejects(service.checkoutRemote('origin/main'), (error) => error.code === 'branch-exists');
});

test('fetch prunes deleted remote branches without touching local ones', async (t) => {
  const { root, repo, service } = await fixture(t);
  const bare = path.join(root, 'remote.git');
  git(root, 'init', '--quiet', '--bare', bare);
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '--quiet', 'origin', 'main', 'main:refs/heads/doomed');
  git(repo, 'fetch', '--quiet', 'origin');
  git(bare, 'branch', '-D', 'doomed');
  await service.fetch();
  const refs = await service.references();
  assert.deepEqual(refs.remote.map((ref) => ref.name), ['origin/main']);
  assert.deepEqual(refs.local.map((ref) => ref.name), ['main']);
});

test('working and staged versions feed the side-by-side diff', async (t) => {
  const { repo, service } = await fixture(t);
  await writeFile(path.join(repo, 'base.txt'), 'staged\n');
  git(repo, 'add', 'base.txt');
  await writeFile(path.join(repo, 'base.txt'), 'working\n');
  assert.deepEqual(await service.workingVersions('base.txt', true), { original: 'initial\n', modified: 'staged\n', existsBefore: true, existsAfter: true, editable: false });
  const unstaged = await service.workingVersions('base.txt', false);
  assert.deepEqual([unstaged.original, unstaged.modified, unstaged.editable], ['staged\n', 'working\n', true]);
  await writeFile(path.join(repo, 'new.txt'), 'fresh\n');
  const untracked = await service.workingVersions('new.txt', false);
  assert.deepEqual([untracked.original, untracked.modified], ['', 'fresh\n']);
  await writeFile(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
  assert.equal((await service.workingVersions('blob.bin', false)).binary, true);

  git(repo, 'add', '--all'); git(repo, 'commit', '--quiet', '-m', 'second');
  const head = git(repo, 'rev-parse', 'HEAD');
  const committed = await service.commitVersions(head, 'base.txt');
  assert.deepEqual([committed.original, committed.modified], ['initial\n', 'working\n']);
  assert.deepEqual([(await service.commitVersions(head, 'new.txt')).original, (await service.commitVersions(head, 'new.txt')).existsBefore], ['', false]);
});

test('the editor reads and writes only existing files inside the repository', async (t) => {
  const { root, repo, service } = await fixture(t);
  await writeFile(path.join(repo, '.gitignore'), 'ignored.txt\n');
  await writeFile(path.join(repo, 'ignored.txt'), 'x');
  await mkdir(path.join(repo, 'dir'));
  await writeFile(path.join(repo, 'dir', 'note.md'), '# note\n');
  assert.deepEqual(await service.listFiles(), ['.gitignore', 'base.txt', 'dir/note.md']);
  assert.equal((await service.readWorkingFile('dir/note.md')).content, '# note\n');
  await service.writeWorkingFile('dir/note.md', '# edited\r\n');
  assert.equal(await readFile(path.join(repo, 'dir', 'note.md'), 'utf8'), '# edited\r\n');
  await writeFile(path.join(root, 'outside.txt'), 'secret');
  for (const bad of ['../outside.txt', path.join(root, 'outside.txt'), '.git/config', 'dir/../../outside.txt', 'missing.txt']) {
    await assert.rejects(service.writeWorkingFile(bad, 'x'), (error) => error.code === 'invalid-path', bad);
  }
  try { await symlink(path.join(root, 'outside.txt'), path.join(repo, 'link.txt')); }
  catch { return; } // Liens symboliques indisponibles (Windows sans mode développeur).
  await assert.rejects(service.readWorkingFile('link.txt'), (error) => error.code === 'invalid-path');
});

test('a conflict exposes the three versions and resolving it lets the operation continue', async (t) => {
  const { repo, service } = await conflicted(t);
  const state = await service.status();
  assert.equal(state.operation, 'cherry-pick');
  const file = state.files.find((item) => item.path === 'base.txt');
  assert.deepEqual([file.conflicted, file.staged, file.unstaged], [true, false, false]);
  const versions = await service.conflictVersions('base.txt');
  assert.deepEqual([versions.base, versions.ours, versions.theirs, versions.operation], ['initial\n', 'main version\n', 'side version\n', 'cherry-pick']);
  assert.equal(conflictCount(versions.merged), 1);
  await assert.rejects(service.continueOperation(), (error) => error.code === 'conflicts-remaining');
  await service.resolveConflict('base.txt', resolveAll(versions.merged, 'both'));
  const done = await service.continueOperation();
  assert.equal(done.status.operation, null);
  assert.equal(git(repo, 'show', '-s', '--format=%s', 'HEAD'), 'side edit');
  assert.equal(await readFile(path.join(repo, 'base.txt'), 'utf8'), 'main version\nside version\n');
});

test('aborting a conflicted operation restores the previous HEAD', async (t) => {
  const { repo, service } = await conflicted(t);
  const result = await service.abortOperation();
  assert.equal(result.operation, 'cherry-pick');
  assert.equal(result.status.operation, null);
  assert.equal(git(repo, 'show', '-s', '--format=%s', 'HEAD'), 'main edit');
  await assert.rejects(service.abortOperation(), (error) => error.code === 'no-operation');
});

test('amend rewrites the last commit with the staged content and keeps a recovery ref', async (t) => {
  const { repo, service } = await fixture(t);
  await commitFile(repo, 'a.txt', 'a\n', 'add a');
  const before = git(repo, 'rev-parse', 'HEAD');
  assert.equal(await service.headMessage(), 'add a');
  await writeFile(path.join(repo, 'b.txt'), 'b\n');
  await service.stage('b.txt');
  const result = await service.amend('feat: add a and b');
  assert.equal(git(repo, 'show', '-s', '--format=%s', 'HEAD'), 'feat: add a and b');
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '2');
  assert.deepEqual(git(repo, 'show', '--format=', '--name-only', 'HEAD').split('\n').sort(), ['a.txt', 'b.txt']);
  assert.equal(git(repo, 'rev-parse', result.recoveryRef), before);
  assert.equal(await service.headPublished(), false);
});

test('interactive rebase rewords, squashes with the chosen message, reorders and drops', async (t) => {
  const { repo, service } = await fixture(t);
  const base = git(repo, 'rev-parse', 'HEAD');
  await commitFile(repo, 'one.txt', '1\n', 'one');
  await commitFile(repo, 'two.txt', '2\n', 'two');
  await commitFile(repo, 'three.txt', '3\n', 'three');
  await commitFile(repo, 'four.txt', '4\n', 'four');
  const { commits } = await service.interactiveRebaseCommits(base);
  assert.deepEqual(commits.map((commit) => commit.message), ['one', 'two', 'three', 'four']);
  const [one, two, three, four] = commits;
  await service.interactiveRebase(base, [
    { hash: three.hash, action: 'reword', message: 'feat: three, renamed\n\nwith a body' },
    { hash: one.hash, action: 'pick' },
    { hash: two.hash, action: 'squash', message: 'feat: one and two' },
    { hash: four.hash, action: 'drop' },
  ]);
  assert.equal(git(repo, 'log', '--format=%s', `${base}..HEAD`), 'feat: one and two\nfeat: three, renamed');
  assert.equal(git(repo, 'log', '-1', '--skip=1', '--format=%b'), 'with a body');
  assert.equal(await service.operation(), null);
  await assert.rejects(service.interactiveRebase(base, [{ hash: git(repo, 'rev-parse', 'HEAD'), action: 'reword', message: ' ' }]), (error) => error.code === 'invalid-rebase-plan');
});

test('interactive rebase squashes across a dropped commit into the last kept one', async (t) => {
  const { repo, service } = await fixture(t);
  const base = git(repo, 'rev-parse', 'HEAD');
  await commitFile(repo, 'one.txt', '1\n', 'one');
  await commitFile(repo, 'two.txt', '2\n', 'two');
  await commitFile(repo, 'three.txt', '3\n', 'three');
  const [one, two, three] = (await service.interactiveRebaseCommits(base)).commits;
  await service.interactiveRebase(base, [
    { hash: one.hash, action: 'pick' },
    { hash: two.hash, action: 'drop' },
    { hash: three.hash, action: 'squash', message: 'one and three' },
  ]);
  assert.equal(git(repo, 'log', '--format=%s', `${base}..HEAD`), 'one and three');
  assert.equal(git(repo, 'ls-tree', '--name-only', 'HEAD').split('\n').sort().join(','), 'base.txt,one.txt,three.txt');
  await assert.rejects(service.interactiveRebaseCommits(base).then(({ commits }) => service.interactiveRebase(base, [{ hash: commits[0].hash, action: 'squash', message: 'x' }])), (error) => error.code === 'invalid-rebase-plan');
});

test('conflict markers parse with diff3 bases and resolve block by block', () => {
  const text = 'a\r\n<<<<<<< HEAD\r\nmine\r\n||||||| base\r\norig\r\n=======\r\ntheirs\r\n>>>>>>> side\r\nz\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> side';
  const blocks = parseConflicts(text);
  const conflicts = blocks.filter((block) => block.type === 'conflict');
  assert.equal(conflicts.length, 2);
  assert.deepEqual([conflicts[0].startLine, conflicts[0].endLine, conflicts[0].labels.theirs], [2, 8, 'side']);
  assert.equal(resolveBlock(conflicts[0], 'base'), 'orig\r\n');
  assert.equal(resolveBlock(conflicts[1], 'both'), 'x\ny\n');
  assert.equal(resolveAll(text, 'theirs'), 'a\r\ntheirs\r\nz\ny\n');
  assert.equal(resolveAll('no conflict\n<<<<<<< dangling\n', 'ours'), 'no conflict\n<<<<<<< dangling\n');
});

test('conventional commit headers round-trip and suggest known scopes', () => {
  assert.equal(formatHeader({ type: 'feat', scope: 'ui editor', breaking: true, subject: ' add Monaco ' }), 'feat(ui-editor)!: add Monaco');
  assert.deepEqual(parseHeader('fix(git): handle gone upstream'), { type: 'fix', scope: 'git', breaking: false, subject: 'handle gone upstream' });
  assert.deepEqual(parseHeader('Random message'), { type: '', scope: '', breaking: false, subject: 'Random message' });
  assert.equal(withBreakingFooter('Body', 'API changed'), 'Body\n\nBREAKING CHANGE: API changed');
  assert.equal(withBreakingFooter('Body\n\nBREAKING CHANGE: old', ''), 'Body');
  assert.deepEqual(knownScopes(['feat(ui): a', 'fix(git): b', 'fix(ui): c', 'chore: d']), ['ui', 'git']);
});
