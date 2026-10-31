import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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

// Sous Windows, le `git` du PATH est en général Git\cmd\git.exe, un lanceur qui démarre un second processus : on
// appelle directement le binaire indiqué par `git --exec-path`, ce qui divise environ par deux le coût de chaque
// commande. Ce binaire retrouve seul sh, ssh et les hooks ; à défaut, on garde `git`.
let gitExecutable = null;
function gitBinary() {
  if (gitExecutable) return gitExecutable;
  gitExecutable = 'git';
  if (process.platform === 'win32') {
    const result = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true, env: sanitizedEnv() });
    const candidate = result.status === 0 ? path.join(result.stdout.trim(), 'git.exe') : null;
    if (candidate && existsSync(candidate)) gitExecutable = candidate;
  }
  return gitExecutable;
}

function runGit(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(gitBinary(), args, {
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
    this.operation = operation;
  }
}

// En-tête de `status --branch` : « ## main...origin/main [ahead 1] », « ## main », « ## HEAD (no branch) »
// ou « ## No commits yet on main ». Un upstream « [gone] » (branche distante supprimée) compte comme absent.
export function parseBranchHeader(header) {
  const text = header.slice(3);
  if (text.startsWith('HEAD (no branch)')) return { branch: '(HEAD détachée)', upstream: null };
  const unborn = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(text);
  if (unborn) return { branch: unborn[1], upstream: null };
  const [names, tracking = ''] = text.split(' [');
  const [branch, upstream] = names.split('...');
  return { branch, upstream: upstream && !tracking.startsWith('gone') ? upstream : null };
}

function parseStatus(raw) {
  const fields = raw.split('\0');
  const files = [];
  let header = { branch: '(HEAD détachée)', upstream: null };
  for (let i = 0; i < fields.length - 1; i += 1) {
    const record = fields[i];
    if (record.startsWith('## ')) { header = parseBranchHeader(record); continue; }
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
  return { files, ...header };
}

// `%D` avec --decorate=full : « HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1 ».
function parseDecorations(raw) {
  const refs = [];
  for (let item of raw.split(', ').filter(Boolean)) {
    let head = false;
    if (item.startsWith('HEAD -> ')) { head = true; item = item.slice(8); }
    if (item === 'HEAD') { refs.push({ type: 'head', name: 'HEAD', head: true }); continue; }
    if (item.startsWith('tag: refs/tags/')) refs.push({ type: 'tag', name: item.slice(15), head });
    else if (item.startsWith('refs/heads/')) refs.push({ type: 'local', name: item.slice(11), head });
    else if (item.startsWith('refs/remotes/')) { if (!item.endsWith('/HEAD')) refs.push({ type: 'remote', name: item.slice(13), head }); }
  }
  return refs;
}

// Packaged Electron's execPath is the app binary: without this flag the rebase plan editor
// would start a second app window instead of running the script (which lives inside app.asar).
// The assignment prefixes only the editor command (Git runs it through sh), so user hooks never inherit it.
export function sequenceEditorRuntimePrefix(versions = process.versions) {
  return versions.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
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

  // Un seul lancement de git : l'en-tête `--branch` donne aussi la branche courante et son upstream.
  async status() {
    await this.#ensureRepositoryPath();
    return parseStatus(await runGit(this.repositoryPath, ['status', '--porcelain=v1', '--branch', '-z', '--untracked-files=all']));
  }

  // Tout ce qu'affiche l'interface pour un dépôt, en trois lancements de git parallèles.
  async snapshot() {
    await this.#ensureRepositoryPath();
    const [status, graph, refs] = await Promise.all([this.status(), this.graph(), this.references()]);
    return { status, graph, refs };
  }

  async history() {
    const raw = await runGit(this.repositoryPath, ['log', '-n', '100', '--date=iso-strict', '--format=%H%x00%h%x00%an%x00%ad%x00%s']);
    return raw.split('\n').filter(Boolean).map((line) => {
      const [hash, shortHash, author, date, ...subject] = line.split('\0');
      return { hash, shortHash, author, date, subject: subject.join('\0') };
    });
  }

  // Graphe de toutes les branches locales, distantes et tags (les refs de récupération internes sont exclues).
  async graph(limit = 500) {
    await this.#ensureRepositoryPath();
    const headCommit = () => runGit(this.repositoryPath, ['rev-parse', '--verify', '--quiet', 'HEAD']).then((hash) => hash.trim() || null, () => null);
    let raw;
    try {
      raw = await runGit(this.repositoryPath, [
        'log', '--date-order', '-n', String(limit), '--branches', '--remotes', '--tags', 'HEAD',
        '--decorate=full', '--decorate-refs-exclude=refs/git-workbench/*',
        '--format=%H%x00%P%x00%an%x00%at%x00%D%x00%b%x00%s%x1e',
      ]);
    } catch (error) {
      // Dépôt sans aucun commit : `log HEAD` échoue, ce n'est pas une erreur pour l'interface.
      if (!await headCommit()) return { head: null, commits: [] };
      throw error;
    }
    const commits = raw.split('\x1e').map((record) => record.replace(/^\n/, '')).filter(Boolean).map((record) => {
      const [hash, parents, author, timestamp, decorations, body, ...subject] = record.split('\0');
      const summary = body.split('\n').map((line) => line.trim()).find(Boolean) || '';
      return { hash, parents: parents ? parents.split(' ') : [], author, timestamp: Number(timestamp), refs: parseDecorations(decorations), subject: subject.join('\0'), summary };
    });
    // La décoration HEAD évite un lancement de git ; on ne le paie que si HEAD est hors des commits affichés.
    const head = commits.find((commit) => commit.refs.some((ref) => ref.head))?.hash ?? await headCommit();
    return { head, commits };
  }

  async commitDetails(revision) {
    // Un SHA complet (cas du graphe) se lit pendant que sa validation tourne ; sinon on résout d'abord la révision.
    const full40 = typeof revision === 'string' && /^[0-9a-f]{40}$/i.test(revision);
    await this.#ensureRepositoryPath();
    const resolving = this.#resolveCommit(revision);
    const hash = full40 ? revision : await resolving;
    const [, record, files] = await Promise.all([
      resolving,
      runGit(this.repositoryPath, ['show', '-s', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%cI%x00%B', hash]),
      this.#commitFiles(hash),
    ]);
    const [full, parents, author, email, authorDate, committer, commitDate, ...body] = record.split('\0');
    return { hash: full, parents: parents ? parents.split(' ') : [], author, email, authorDate, committer, commitDate, message: body.join('\0').trimEnd(), files };
  }

  async commitFileDiff(revision, filePath) {
    await this.#ensureRepositoryPath();
    const hash = await this.#resolveCommit(revision);
    const entry = (await this.#commitFiles(hash)).find((file) => file.path === filePath);
    if (!entry) throw new GitWorkbenchError('file-not-in-commit');
    const paths = entry.originalPath ? [entry.originalPath, filePath] : [filePath];
    return runGit(this.repositoryPath, ['show', '--format=', '--no-ext-diff', '--no-color', '-M', '--diff-merges=first-parent', hash, '--', ...paths]);
  }

  async diff(filePath, staged = false) {
    const entry = await this.#statusEntry(filePath);
    if (!staged && entry.untracked) {
      return runGit(this.repositoryPath, ['diff', '--no-index', '--no-ext-diff', '--no-color', '--', '/dev/null', filePath], { acceptExitCodes: [1] });
    }
    const args = ['diff', '--no-ext-diff', '--no-color'];
    if (staged) args.push('--cached');
    args.push('--', filePath);
    if (entry.originalPath) args.push(entry.originalPath);
    return runGit(this.repositoryPath, args);
  }

  async stage(filePath) {
    await this.#statusEntry(filePath);
    await runGit(this.repositoryPath, ['add', '--', filePath]);
    return this.status();
  }

  async unstage(filePath) {
    await this.#statusEntry(filePath);
    await runGit(this.repositoryPath, ['reset', '--', filePath]);
    return this.status();
  }

  async stageAll() {
    await this.#ensureRepositoryPath();
    await runGit(this.repositoryPath, ['add', '--all']);
    return this.status();
  }

  async unstageAll() {
    await this.#ensureRepositoryPath();
    await runGit(this.repositoryPath, ['reset', '--quiet']);
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

  // Sans point de départ : crée la branche au HEAD et bascule dessus. Avec : la crée sur ce commit sans changer de branche.
  async createBranch(name, startPoint = null) {
    await this.#ensureRepositoryPath();
    this.#validateBranchName(name);
    if (startPoint) await runGit(this.repositoryPath, ['branch', name, await this.#resolveCommit(startPoint)]);
    else await runGit(this.repositoryPath, ['switch', '--create', name]);
    return this.status();
  }

  async references() {
    await this.#ensureRepositoryPath();
    const raw = await runGit(this.repositoryPath, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)', 'refs/heads', 'refs/remotes', 'refs/tags']);
    const result = { local: [], remote: [], tags: [] };
    for (const line of raw.split('\n').filter(Boolean)) {
      // %(*objectname) est le commit pointé par un tag annoté.
      const [ref, object, peeled, head, upstream, track] = line.split('\0');
      const hash = peeled || object;
      if (ref.startsWith('refs/heads/')) {
        const ahead = Number(/ahead (\d+)/.exec(track)?.[1] || 0);
        const behind = Number(/behind (\d+)/.exec(track)?.[1] || 0);
        result.local.push({ name: ref.slice(11), hash, current: head === '*', upstream: upstream || null, ahead, behind });
      } else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) result.remote.push({ name: ref.slice(13), hash });
      else if (ref.startsWith('refs/tags/')) result.tags.push({ name: ref.slice(10), hash });
    }
    return result;
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
    const sequenceEditor = `${sequenceEditorRuntimePrefix()}${quote(process.execPath)} ${quote(editorPath)} ${quote(planPath)}`;
    try {
      try { await runGit(this.repositoryPath, ['rebase', '--interactive', '--no-autosquash', target], { env: { GIT_SEQUENCE_EDITOR: sequenceEditor, GIT_WORKBENCH_REBASE_PLAN: planPath } }); }
      catch (error) { throw new GitWorkbenchError(error.code || 'git-operation-failed', recoveryRef, 'rebase'); }
      return { recoveryRef, status: await this.status() };
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  // Seuls les fichiers que `git status` liste peuvent être indexés, désindexés ou comparés.
  async #statusEntry(filePath) {
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) throw new GitWorkbenchError('invalid-path');
    const entry = (await this.status()).files.find((file) => file.path === filePath);
    if (!entry) throw new GitWorkbenchError('file-not-in-status');
    return entry;
  }

  async #commitFiles(hash) {
    const show = (format) => runGit(this.repositoryPath, ['show', '--format=', format, '-z', '-M', '--diff-merges=first-parent', hash]);
    const [raw, numstat] = await Promise.all([show('--name-status'), show('--numstat')]);
    const fields = raw.split('\0');
    const files = [];
    for (let i = 0; i < fields.length - 1; i += 1) {
      const status = fields[i].replace(/^\n/, '');
      if (!status) continue;
      if (status[0] === 'R' || status[0] === 'C') { files.push({ status: status[0], originalPath: fields[i + 1], path: fields[i + 2] }); i += 2; }
      else { files.push({ status: status[0], originalPath: null, path: fields[i + 1] }); i += 1; }
    }
    // --numstat suit le même ordre que --name-status ; « - » signale un fichier binaire.
    const stats = numstat.split('\0');
    let index = 0;
    for (let i = 0; i < stats.length - 1 && index < files.length; i += 1) {
      const [added, deleted, inlinePath] = stats[i].replace(/^\n/, '').split('\t');
      if (added === undefined || deleted === undefined) continue;
      if (inlinePath === '') i += 2;
      files[index].binary = added === '-';
      files[index].additions = added === '-' ? 0 : Number(added);
      files[index].deletions = deleted === '-' ? 0 : Number(deleted);
      index += 1;
    }
    return files;
  }

  // Public : le processus principal vérifie l'arbre propre avant de demander confirmation d'une réécriture.
  async assertClean() {
    await this.#ensureRepositoryPath();
    await this.#assertClean();
  }

  async #assertClean() {
    const status = await this.status();
    if (status.files.length) throw new GitWorkbenchError('working-tree-not-clean');
  }

  // Vérifie que le dossier est toujours la racine du dépôt choisi. Le résultat est gardé quelques secondes : chaque
  // lancement de git coûte cher sous Windows et une rafale d'appels (instantané, staging) n'a besoin que d'une vérification.
  #verifiedUntil = 0;
  async #ensureRepositoryPath() {
    if (Date.now() < this.#verifiedUntil) return;
    const root = (await runGit(this.repositoryPath, ['rev-parse', '--show-toplevel'])).trim();
    if (path.resolve(root) !== this.repositoryPath) throw new GitWorkbenchError('repository-mismatch');
    this.#verifiedUntil = Date.now() + 3000;
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
