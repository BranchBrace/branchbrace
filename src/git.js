import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MAX_BUFFER = 16 * 1024 * 1024;

// Ces variables redéfinissent où Git lit/écrit le dépôt, l'index ou les objets.
// Héritées de l'environnement du processus hôte, elles peuvent détourner une
// opération vers un dépôt différent de celui choisi par l'utilisateur
// (cwd), même si le chemin affiché à l'écran reste le bon.
const DANGEROUS_GIT_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CEILING_DIRECTORIES',
];

function sanitizedEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of DANGEROUS_GIT_ENV_VARS) delete env[name];
  return env;
}

function runGit(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: sanitizedEnv(options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let settled = false;
    const failTooLarge = () => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new GitWorkbenchError('git-output-too-large'));
    };
    child.stdout.on('data', (chunk) => {
      stdoutLength += chunk.length;
      stdout.push(chunk);
      if (stdoutLength > MAX_BUFFER) failTooLarge();
    });
    child.stderr.on('data', (chunk) => {
      stderrLength += chunk.length;
      stderr.push(chunk);
      if (stderrLength > MAX_BUFFER) failTooLarge();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(new GitWorkbenchError(error.code === 'ENOENT' ? 'git-missing' : 'git-launch-failed'));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (code === 0 || options.acceptExitCodes?.includes(code)) return resolve(result.stdout);
      reject(new GitWorkbenchError(classifyFailure(args, result.stderr)));
    });
  });
}

function classifyFailure(args, stderr) {
  const text = stderr.toLowerCase();
  if (text.includes('conflict') || text.includes('could not apply') || text.includes('fix conflicts')) return 'conflict';
  if (args[0] === 'push' && (text.includes('rejected') || text.includes('non-fast-forward'))) return 'push-rejected';
  if (args[0] === 'push') return 'push-indeterminate';
  if (text.includes('not a git repository')) return 'not-a-repository';
  if (text.includes('local changes') || text.includes('would be overwritten')) return 'unsafe-working-tree';
  return 'git-operation-failed';
}

export class GitWorkbenchError extends Error {
  constructor(code, recoveryRef = null, operation = null) {
    super(recoveryRef ? `${code}; recovery=${recoveryRef}; abort with git ${operation} --abort` : code);
    this.name = 'GitWorkbenchError';
    this.code = code;
    this.recoveryRef = recoveryRef;
  }
}

function parseStatus(raw) {
  const fields = raw.split('\0');
  const files = [];
  for (let i = 0; i < fields.length - 1; i += 1) {
    const record = fields[i];
    if (record.length < 4) continue;
    const x = record[0];
    const y = record[1];
    let filePath = record.slice(3);
    let originalPath = null;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      i += 1;
      originalPath = fields[i] || null;
    }
    files.push({ path: filePath, originalPath, indexStatus: x, worktreeStatus: y, staged: x !== ' ' && x !== '?', unstaged: y !== ' ', untracked: x === '?' && y === '?' });
  }
  return files;
}

export class GitService {
  constructor(repositoryPath) {
    this.repositoryPath = path.resolve(repositoryPath);
  }

  async verifyRepository() {
    const root = await runGit(this.repositoryPath, ['rev-parse', '--show-toplevel']);
    this.repositoryPath = path.resolve(root.trim());
    return this.repositoryPath;
  }

  async status() {
    await this.#ensureRepositoryPath();
    const [raw, branch, upstream] = await Promise.all([
      runGit(this.repositoryPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      runGit(this.repositoryPath, ['branch', '--show-current']),
      runGit(this.repositoryPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => ''),
    ]);
    return { files: parseStatus(raw), branch: branch.trim() || '(HEAD détachée)', upstream: upstream.trim() || null };
  }

  async history() {
    const raw = await runGit(this.repositoryPath, ['log', '-n', '100', '--date=iso-strict', '--format=%H%x00%h%x00%an%x00%ad%x00%s']);
    return raw.split('\n').filter(Boolean).map((line) => {
      const [hash, shortHash, author, date, ...subject] = line.split('\0');
      return { hash, shortHash, author, date, subject: subject.join('\0') };
    });
  }

  async diff(filePath, staged = false) {
    await this.#assertTrackedOrUntracked(filePath);
    const entry = (await this.status()).files.find((file) => file.path === filePath);
    if (!staged && entry?.untracked) {
      return runGit(this.repositoryPath, ['diff', '--no-index', '--no-ext-diff', '--no-color', '--', '/dev/null', filePath], { acceptExitCodes: [1] });
    }
    const args = ['diff', '--no-ext-diff', '--no-color'];
    if (staged) args.push('--cached');
    args.push('--', filePath);
    if (entry?.originalPath) args.push(entry.originalPath);
    return runGit(this.repositoryPath, args);
  }

  async stage(filePath) {
    await this.#assertTrackedOrUntracked(filePath);
    await runGit(this.repositoryPath, ['add', '--', filePath]);
    return this.status();
  }

  async unstage(filePath) {
    await this.#assertTrackedOrUntracked(filePath);
    await runGit(this.repositoryPath, ['reset', '--', filePath]);
    return this.status();
  }

  async commit(message) {
    await this.#ensureRepositoryPath();
    if (typeof message !== 'string' || !message.trim()) throw new GitWorkbenchError('commit-message-required');
    const staged = await runGit(this.repositoryPath, ['diff', '--cached', '--quiet']).then(() => false).catch((error) => {
      if (error.code === 'git-operation-failed') return true;
      throw error;
    });
    if (!staged) throw new GitWorkbenchError('nothing-staged');
    await runGit(this.repositoryPath, ['commit', '-m', message]);
    return runGit(this.repositoryPath, ['rev-parse', 'HEAD']).then((hash) => hash.trim());
  }

  async push(expectedUpstream) {
    await this.#ensureRepositoryPath();
    const upstream = (await runGit(this.repositoryPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim();
    if (expectedUpstream && upstream !== expectedUpstream) throw new GitWorkbenchError('upstream-changed');
    const currentBranch = (await runGit(this.repositoryPath, ['branch', '--show-current'])).trim();
    if (!currentBranch) throw new GitWorkbenchError('upstream-missing');
    const remote = (await runGit(this.repositoryPath, ['config', '--get', `branch.${currentBranch}.remote`])).trim();
    if (!remote || !upstream.startsWith(`${remote}/`)) throw new GitWorkbenchError('upstream-missing');
    const branch = upstream.slice(remote.length + 1);
    const before = (await runGit(this.repositoryPath, ['rev-parse', 'HEAD'])).trim();
    await runGit(this.repositoryPath, ['push', '--porcelain', remote, `HEAD:refs/heads/${branch}`]);
    const remoteRef = await runGit(this.repositoryPath, ['ls-remote', '--heads', remote, `refs/heads/${branch}`]);
    const actual = remoteRef.trim().split(/\s+/)[0];
    if (!actual || actual !== before) throw new GitWorkbenchError('push-verification-failed');
    return { upstream, hash: actual };
  }

  async branches() {
    await this.#ensureRepositoryPath();
    const raw = await runGit(this.repositoryPath, ['for-each-ref', '--format=%(refname:short)%00%(HEAD)', 'refs/heads']);
    return raw.split('\n').filter(Boolean).map((line) => {
      const [name, head] = line.split('\0');
      return { name, current: head === '*' };
    });
  }

  async createBranch(name) {
    await this.#ensureRepositoryPath();
    this.#validateBranchName(name);
    await runGit(this.repositoryPath, ['switch', '--create', name]);
    return this.status();
  }

  async switchBranch(name) {
    await this.#ensureRepositoryPath();
    this.#validateBranchName(name);
    const branches = await this.branches();
    if (!branches.some((branch) => branch.name === name)) throw new GitWorkbenchError('branch-not-found');
    await runGit(this.repositoryPath, ['switch', name]);
    return this.status();
  }

  async cherryPick(commit) {
    const hash = await this.#resolveCommit(commit);
    await this.#assertClean();
    const recoveryRef = await this.#saveRecoveryRef('cherry-pick');
    try { await runGit(this.repositoryPath, ['cherry-pick', hash]); }
    catch (error) { throw new GitWorkbenchError(error.code || 'git-operation-failed', recoveryRef, 'cherry-pick'); }
    return { recoveryRef, status: await this.status() };
  }

  async rebase(upstream) {
    const target = await this.#resolveCommit(upstream);
    await this.#assertClean();
    const recoveryRef = await this.#saveRecoveryRef('rebase');
    try { await runGit(this.repositoryPath, ['rebase', target]); }
    catch (error) { throw new GitWorkbenchError(error.code || 'git-operation-failed', recoveryRef, 'rebase'); }
    return { recoveryRef, status: await this.status() };
  }

  async previewCommit(revision) {
    await this.#ensureRepositoryPath();
    const hash = await this.#resolveCommit(revision);
    const record = await runGit(this.repositoryPath, ['show', '-s', '--format=%H%x00%h%x00%s', hash]);
    const fields = record.trimEnd().split('\0');
    return { hash: fields[0], shortHash: fields[1], subject: fields.slice(2).join('\0') };
  }

  async interactiveRebaseCommits(upstream) {
    await this.#ensureRepositoryPath();
    const target = await this.#resolveCommit(upstream);
    const raw = await runGit(this.repositoryPath, ['rev-list', '--reverse', `${target}..HEAD`]);
    const commits = [];
    for (const hash of raw.split('\n').filter(Boolean)) {
      const record = await runGit(this.repositoryPath, ['show', '-s', '--format=%H%x00%h%x00%s', hash]);
      const fields = record.trimEnd().split('\0');
      commits.push({ hash: fields[0], shortHash: fields[1], subject: fields.slice(2).join('\0') });
    }
    return { upstream: target, commits };
  }

  async interactiveRebase(upstream, plan) {
    const { upstream: target, commits } = await this.interactiveRebaseCommits(upstream);
    await this.#assertClean();
    if (!Array.isArray(plan) || plan.length !== commits.length || new Set(plan.map((item) => item?.hash)).size !== commits.length) throw new GitWorkbenchError('invalid-rebase-plan');
    const validHashes = new Set(commits.map((item) => item.hash));
    if (plan.some((item) => !validHashes.has(item.hash) || !['pick', 'drop', 'fixup'].includes(item.action))) throw new GitWorkbenchError('invalid-rebase-plan');
    let previousCanFixup = false;
    for (const item of plan) {
      if (item.action === 'fixup' && !previousCanFixup) throw new GitWorkbenchError('invalid-rebase-plan');
      previousCanFixup = item.action !== 'drop';
    }
    const recoveryRef = await this.#saveRecoveryRef('interactive-rebase');
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'git-workbench-rebase-'));
    const planPath = path.join(tempDirectory, 'plan.json');
    const editorPath = fileURLToPath(new URL('../scripts/apply-rebase-plan.mjs', import.meta.url));
    await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const sequenceEditor = `${quote(process.execPath)} ${quote(editorPath)} ${quote(planPath)}`;
    try {
      try { await runGit(this.repositoryPath, ['rebase', '--interactive', '--no-autosquash', target], { env: { GIT_SEQUENCE_EDITOR: sequenceEditor, GIT_WORKBENCH_REBASE_PLAN: planPath } }); }
      catch (error) { throw new GitWorkbenchError(error.code || 'git-operation-failed', recoveryRef, 'rebase'); }
      return { recoveryRef, status: await this.status() };
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  async #assertTrackedOrUntracked(filePath) {
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) throw new GitWorkbenchError('invalid-path');
    const status = await this.status();
    if (!status.files.some((file) => file.path === filePath)) throw new GitWorkbenchError('file-not-in-status');
  }

  async #assertClean() {
    const status = await this.status();
    if (status.files.length) throw new GitWorkbenchError('working-tree-not-clean');
  }

  async #ensureRepositoryPath() {
    const root = (await runGit(this.repositoryPath, ['rev-parse', '--show-toplevel'])).trim();
    if (path.resolve(root) !== this.repositoryPath) throw new GitWorkbenchError('repository-mismatch');
  }

  async #resolveCommit(revision) {
    if (typeof revision !== 'string' || revision.length > 255 || revision.startsWith('-') || /[\s\0~^:?*\\[\\]\\]/.test(revision) || revision.includes('..')) throw new GitWorkbenchError('invalid-revision');
    if (/^[0-9a-f]{7,40}$/i.test(revision)) {
      return (await runGit(this.repositoryPath, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])).trim();
    }
    try {
      await runGit(this.repositoryPath, ['check-ref-format', '--branch', revision]);
      return (await runGit(this.repositoryPath, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])).trim();
    } catch {
      throw new GitWorkbenchError('invalid-revision');
    }
  }

  async #saveRecoveryRef(operation) {
    const head = (await runGit(this.repositoryPath, ['rev-parse', 'HEAD'])).trim();
    const ref = `refs/git-workbench/recovery/${operation}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await runGit(this.repositoryPath, ['update-ref', ref, head]);
    return ref;
  }

  #validateBranchName(name) {
    if (typeof name !== 'string' || !name.trim() || name.startsWith('-') || name.includes('\0')) throw new GitWorkbenchError('invalid-branch-name');
    if (name !== name.trim()) throw new GitWorkbenchError('invalid-branch-name');
  }
}
