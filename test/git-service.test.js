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

// Dépôt suivi par origin/main et un second clone qui publie des commits sur le remote bare local.
async function trackedFixture(t) {
  const context = await fixture(t);
  const { root, repo } = context;
  const bare = path.join(root, 'remote.git');
  const competitor = path.join(root, 'competitor');
  git(root, 'init', '--quiet', '--bare', bare);
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '--quiet', '-u', 'origin', 'main');
  git(root, 'clone', '--quiet', bare, competitor);
  git(competitor, 'config', 'user.name', 'Competing Writer');
  git(competitor, 'config', 'user.email', 'competitor@example.invalid');
  const publish = async (file, content) => {
    await writeFile(path.join(competitor, file), content);
    git(competitor, 'add', file); git(competitor, 'commit', '--quiet', '-m', `remote ${file}`);
    git(competitor, 'push', '--quiet');
    return git(competitor, 'rev-parse', 'HEAD');
  };
  return { ...context, bare, publish };
}

test('background fetch reports the current branch behind its upstream without moving it', async (t) => {
  const { repo, service, publish } = await trackedFixture(t);
  const headBefore = git(repo, 'rev-parse', 'HEAD');
  await publish('remote.txt', 'remote advance\n');
  assert.deepEqual(await service.fetch({ background: true }), { skipped: null });
  const status = await service.status();
  assert.equal(status.upstream, 'origin/main');
  assert.equal(status.behind, 1);
  assert.equal(status.ahead, 0);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), headBefore);
});

test('background fetch is skipped while a Git operation is in progress', async (t) => {
  const { repo, service, publish } = await trackedFixture(t);
  await publish('remote.txt', 'remote advance\n');
  const before = git(repo, 'rev-parse', 'refs/remotes/origin/main');
  await writeFile(path.join(repo, '.git', 'MERGE_HEAD'), `${before}\n`);
  assert.deepEqual(await service.fetch({ background: true }), { skipped: 'operation', operation: 'merge' });
  assert.equal(git(repo, 'rev-parse', 'refs/remotes/origin/main'), before);
});

test('pull fast-forwards the current branch to its upstream and verifies HEAD', async (t) => {
  const { repo, service, publish } = await trackedFixture(t);
  const remoteHead = await publish('remote.txt', 'remote advance\n');
  await writeFile(path.join(repo, 'untracked.txt'), 'kept\n');
  const result = await service.pull('origin/main');
  assert.equal(result.pulled, true);
  assert.equal(result.upstream, 'origin/main');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), remoteHead);
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '2');
  assert.equal(await readFile(path.join(repo, 'untracked.txt'), 'utf8'), 'kept\n');
  assert.equal((await service.pull('origin/main')).pulled, false);
});

test('pull leaves diverged branches untouched and the status reports ahead and behind', async (t) => {
  const { repo, service, publish } = await trackedFixture(t);
  await publish('remote.txt', 'remote advance\n');
  await writeFile(path.join(repo, 'base.txt'), 'local advance\n');
  await service.stage('base.txt'); await service.commit('local advance');
  const localHead = git(repo, 'rev-parse', 'HEAD');
  const result = await service.pull('origin/main');
  assert.deepEqual([result.pulled, result.diverged], [false, true]);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), localHead);
  assert.equal(git(repo, 'rev-list', '--merges', '--count', 'HEAD'), '0');
  const status = await service.status();
  assert.equal(status.operation, null);
  assert.deepEqual([status.ahead, status.behind], [1, 1]);
});

test('pull leaves conflicting uncommitted changes to Git’s refusal', async (t) => {
  const { repo, service, publish } = await trackedFixture(t);
  await publish('base.txt', 'remote edit\n');
  await writeFile(path.join(repo, 'base.txt'), 'uncommitted edit\n');
  const localHead = git(repo, 'rev-parse', 'HEAD');
  await assert.rejects(service.pull('origin/main'), (error) => error.code === 'unsafe-working-tree');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), localHead);
  assert.equal(await readFile(path.join(repo, 'base.txt'), 'utf8'), 'uncommitted edit\n');
});

test('background fetch environment never prompts for credentials', async () => {
  const { nonInteractiveEnv, NON_INTERACTIVE_CONFIG, INTERACTIVE_ENV_VARS } = await import('../src/git.js');
  assert.deepEqual(NON_INTERACTIVE_CONFIG, ['-c', 'core.askPass=', '-c', 'credential.interactive=false']);
  assert.deepEqual(INTERACTIVE_ENV_VARS, ['GIT_ASKPASS', 'SSH_ASKPASS']);
  assert.deepEqual(nonInteractiveEnv({}, {}), { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' });
  assert.equal(nonInteractiveEnv({ sshCommand: 'C:/OpenSSH/ssh.exe -i key' }, {}).GIT_SSH_COMMAND, 'C:/OpenSSH/ssh.exe -i key -o BatchMode=yes');
  assert.equal(nonInteractiveEnv({ sshCommand: 'ssh' }, { GIT_SSH_COMMAND: 'ssh -p 2201' }).GIT_SSH_COMMAND, 'ssh -p 2201 -o BatchMode=yes');
  // plink n'a pas BatchMode : `-batch` l'empêche d'ouvrir une boîte de dialogue, et la variante reste explicite pour Git.
  assert.deepEqual(nonInteractiveEnv({}, { GIT_SSH: 'C:\\Program Files\\PuTTY\\plink.exe' }), {
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never',
    GIT_SSH_COMMAND: "'C:\\Program Files\\PuTTY\\plink.exe' -batch", GIT_SSH_VARIANT: 'plink',
  });
  assert.equal(nonInteractiveEnv({ sshCommand: '"C:/PuTTY/PLINK.EXE" -v' }, {}).GIT_SSH_COMMAND, '"C:/PuTTY/PLINK.EXE" -v -batch');
  // TortoisePlink reçoit déjà -batch de Git : seule la variante est fixée.
  assert.deepEqual([nonInteractiveEnv({ sshCommand: 'TortoisePlink.exe' }, {}).GIT_SSH_COMMAND, nonInteractiveEnv({ sshCommand: 'TortoisePlink.exe' }, {}).GIT_SSH_VARIANT], ['TortoisePlink.exe', 'tortoiseplink']);
  // core.sshCommand l'emporte sur GIT_SSH, comme dans Git.
  assert.equal(nonInteractiveEnv({ sshCommand: 'ssh -i key' }, { GIT_SSH: 'plink.exe' }).GIT_SSH_COMMAND, 'ssh -i key -o BatchMode=yes');
  // La variante déclarée (ssh.variant ou GIT_SSH_VARIANT) prime sur le nom du programme.
  assert.equal(nonInteractiveEnv({ sshCommand: 'my-wrapper', sshVariant: 'ssh' }, {}).GIT_SSH_COMMAND, 'my-wrapper -o BatchMode=yes');
  assert.equal(nonInteractiveEnv({ sshCommand: 'my-wrapper' }, { GIT_SSH_VARIANT: 'putty' }).GIT_SSH_COMMAND, 'my-wrapper -batch');
  // Client inconnu : laissé tel quel plutôt que de lui passer une option qu'il ne comprendrait pas.
  assert.equal(nonInteractiveEnv({}, { GIT_SSH: '/usr/local/bin/ssh-wrapper.sh' }).GIT_SSH_COMMAND, undefined);
});

test('background fetch never runs an inherited askpass program', async (t) => {
  const { root, repo, service } = await fixture(t);
  const http = await import('node:http');
  const server = http.createServer((_request, response) => { response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' }); response.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  git(repo, 'remote', 'add', 'origin', `http://127.0.0.1:${server.address().port}/repo.git`);
  git(repo, 'config', 'credential.helper', '');
  const marker = path.join(root, 'askpass-called');
  const askpass = path.join(root, 'askpass.sh');
  await writeFile(askpass, `#!/bin/sh\necho called >> '${marker.replaceAll('\\', '/')}'\necho secret\n`);
  await chmod(askpass, 0o755);
  const saved = { GIT_ASKPASS: process.env.GIT_ASKPASS, SSH_ASKPASS: process.env.SSH_ASKPASS };
  process.env.GIT_ASKPASS = askpass;
  process.env.SSH_ASKPASS = askpass;
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  await assert.rejects(service.fetch({ background: true }), (error) => error.code === 'fetch-failed');
  await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' });
});

test('fetch and pull share a repository lock: background fetches are skipped while one is in flight or queued', async (t) => {
  const { repo, service, publish } = await trackedFixture(t);
  const remoteHead = await publish('remote.txt', 'remote advance\n');
  const first = service.fetch();
  const pull = service.pull('origin/main');
  const second = service.fetch();
  assert.deepEqual(await service.fetch({ background: true }), { skipped: 'in-flight' });
  // Deux tâches en attente derrière le même fetch ne repartent pas ensemble : aucune n'échoue sur « cannot lock ref ».
  const [fetched, pulled, refetched] = await Promise.all([first, pull, second]);
  assert.deepEqual([fetched, refetched], [{ skipped: null }, { skipped: null }]);
  assert.equal(pulled.pulled, true);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), remoteHead);
  // Verrou libéré, y compris après un échec.
  assert.deepEqual(await service.fetch({ background: true }), { skipped: null });
  git(repo, 'remote', 'set-url', 'origin', path.join(repo, 'missing.git'));
  await assert.rejects(service.fetch(), (error) => error.code === 'fetch-failed');
  await assert.rejects(service.fetch({ background: true }), (error) => error.code === 'fetch-failed');
});

test('pull reports a pruned upstream as missing, not as a divergence', async (t) => {
  const { repo, service, bare } = await trackedFixture(t);
  git(repo, 'push', '--quiet', 'origin', 'HEAD:refs/heads/keep');
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/keep');
  git(bare, 'branch', '-D', 'main');
  await assert.rejects(service.pull('origin/main'), (error) => error.code === 'upstream-missing');
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

test('splitting a commit replays it as several commits and keeps the rest of the branch', async (t) => {
  const { repo, service } = await fixture(t);
  await writeFile(path.join(repo, 'a.txt'), 'a\n');
  await writeFile(path.join(repo, 'b.txt'), 'b\n');
  git(repo, 'add', '.'); git(repo, 'commit', '--quiet', '-m', 'a and b');
  const target = git(repo, 'rev-parse', 'HEAD');
  await writeFile(path.join(repo, 'c.txt'), 'c\n');
  git(repo, 'add', 'c.txt'); git(repo, 'commit', '--quiet', '-m', 'c');
  const result = await service.splitCommit(target);
  assert.match(result.recoveryRef, /^refs\/git-workbench\/recovery\/interactive-rebase-/);
  assert.equal(result.status.operation, 'rebase');
  assert.equal(result.status.split.hash, target);
  assert.equal(result.status.split.message, 'a and b');
  assert.equal(result.status.split.ready, true);
  assert.deepEqual(result.status.files.map((file) => file.path).sort(), ['a.txt', 'b.txt']);
  await assert.rejects(service.continueOperation(), (error) => error.code === 'split-changes-remaining');
  await service.stage('a.txt'); await service.commit('a');
  await service.stage('b.txt'); await service.commit('b');
  const done = await service.continueOperation();
  assert.equal(done.status.operation, null);
  assert.equal(git(repo, 'log', '--format=%s').split('\n').join(','), 'c,b,a,initial');
  assert.equal((await service.status()).files.length, 0);
});

test('splitting refuses root commits and commits outside the current branch', async (t) => {
  const { repo, service } = await fixture(t);
  const root = git(repo, 'rev-parse', 'HEAD');
  await assert.rejects(service.splitCommit(root), (error) => error.code === 'split-unsupported');
  git(repo, 'checkout', '--quiet', '-b', 'other');
  await writeFile(path.join(repo, 'o.txt'), 'o\n');
  git(repo, 'add', 'o.txt'); git(repo, 'commit', '--quiet', '-m', 'other');
  const other = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '--quiet', 'main');
  await assert.rejects(service.splitCommit(other), (error) => error.code === 'split-not-on-branch');
});
