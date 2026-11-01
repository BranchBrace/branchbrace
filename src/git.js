import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MAX_BUFFER = 16 * 1024 * 1024;
// Au-delà, un fichier n'est ni affiché dans l'éditeur ni comparé : Monaco resterait utilisable mais la page ralentirait.
const MAX_EDITABLE = 5 * 1024 * 1024;
// Codes `XY` de `git status` d'un chemin non fusionné (conflit en cours de résolution).
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const REBASE_ACTIONS = ['pick', 'reword', 'squash', 'fixup', 'drop'];

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
  if (args[0] === 'fetch') return 'fetch-failed';
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
    const conflicted = CONFLICT_CODES.has(x + y);
    files.push({ path: filePath, originalPath, indexStatus: x, worktreeStatus: y, staged: !conflicted && x !== ' ' && x !== '?', unstaged: !conflicted && y !== ' ', untracked: x === '?' && y === '?', conflicted });
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

// URL web d'un dépôt distant (GitHub, GitLab…) déduite de son URL Git, sans jamais renvoyer d'identifiants : un
// éventuel « user:token@ » d'une URL HTTPS est retiré. Seules les formes https, ssh et scp (git@hôte:chemin) sont lues.
export function remoteWebUrl(url) {
  if (typeof url !== 'string' || !url || /^[a-z]:[\\/]/i.test(url)) return null;
  let host;
  let pathname;
  const scp = /^(?:[^@/\s]+@)?([a-z0-9.-]+):(?!\/\/)([^\s]+)$/i.exec(url);
  if (scp) [, host, pathname] = scp;
  else {
    try {
      const parsed = new URL(url);
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return null;
      host = parsed.hostname;
      pathname = parsed.pathname;
    } catch { return null; }
  }
  pathname = pathname.replace(/^\/+/, '').replace(/\.git\/?$/, '').replace(/\/+$/, '');
  if (!host || !pathname || !/^[a-z0-9.-]+$/i.test(host)) return null;
  const provider = /(^|\.)github\.com$/i.test(host) ? 'github' : /gitlab/i.test(host) ? 'gitlab' : /bitbucket/i.test(host) ? 'bitbucket' : 'git';
  return { host, path: pathname, provider, web: `https://${host}/${pathname}` };
}

// Contenu lu par Git ou sur disque : un octet nul signale un fichier binaire, qu'on ne montre pas comme du texte.
const isBinary = (text) => typeof text === 'string' && text.slice(0, 8000).includes('\0');

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
    const [raw, operation] = await Promise.all([
      runGit(this.repositoryPath, ['status', '--porcelain=v1', '--branch', '-z', '--untracked-files=all']),
      this.operation(),
    ]);
    return { ...parseStatus(raw), operation };
  }

  // Opération Git interrompue (en général par un conflit) qu'il reste à continuer ou annuler.
  async operation() {
    const directory = await this.#gitDirectory();
    const has = (name) => existsSync(path.join(directory, name));
    if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
    if (has('MERGE_HEAD')) return 'merge';
    if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
    if (has('REVERT_HEAD')) return 'revert';
    return null;
  }

  // Récupère les branches de tous les dépôts distants. `--prune` retire les copies locales des branches supprimées
  // côté serveur : seules des références de suivi changent, jamais une branche locale ni l'arbre de travail.
  async fetch() {
    await this.#ensureRepositoryPath();
    await runGit(this.repositoryPath, ['fetch', '--all', '--prune', '--no-recurse-submodules']);
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
    const [raw, urls] = await Promise.all([
      runGit(this.repositoryPath, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)', 'refs/heads', 'refs/remotes', 'refs/tags']),
      runGit(this.repositoryPath, ['config', '--get-regexp', '^remote\\..*\\.url$'], { acceptExitCodes: [1] }),
    ]);
    // Dépôts distants configurés et leur page web : l'URL Git brute (qui peut contenir un jeton) ne quitte pas ce module.
    const remotes = urls.split('\n').filter(Boolean).map((line) => {
      const [key, ...value] = line.split(' ');
      return { name: key.slice(7, -4), ...(remoteWebUrl(value.join(' ')) || { host: null, path: null, provider: 'git', web: null }) };
    }).sort((a, b) => b.name.length - a.name.length);
    const result = { local: [], remote: [], tags: [], remotes: [] };
    for (const line of raw.split('\n').filter(Boolean)) {
      // %(*objectname) est le commit pointé par un tag annoté.
      const [ref, object, peeled, head, upstream, track] = line.split('\0');
      const hash = peeled || object;
      if (ref.startsWith('refs/heads/')) {
        const ahead = Number(/ahead (\d+)/.exec(track)?.[1] || 0);
        const behind = Number(/behind (\d+)/.exec(track)?.[1] || 0);
        result.local.push({ name: ref.slice(11), hash, current: head === '*', upstream: upstream || null, gone: track === 'gone', ahead, behind });
      } else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) {
        const name = ref.slice(13);
        // Un nom de remote peut contenir « / » : on retient le plus long remote configuré qui préfixe la référence.
        const remote = remotes.find((item) => name.startsWith(`${item.name}/`))?.name ?? name.slice(0, name.indexOf('/'));
        result.remote.push({ name, hash, remote, branch: name.slice(remote.length + 1), trackedBy: null });
      } else if (ref.startsWith('refs/tags/')) result.tags.push({ name: ref.slice(10), hash });
    }
    for (const local of result.local) {
      const tracked = result.remote.find((item) => item.name === local.upstream);
      if (tracked) tracked.trackedBy = local.name;
    }
    result.remotes = remotes.sort((a, b) => a.name.localeCompare(b.name));
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

  // Branche présente seulement sur le dépôt distant : crée la branche locale du même nom qui la suit, puis bascule.
  async checkoutRemote(remoteName) {
    await this.#ensureRepositoryPath();
    const { local, remote } = await this.references();
    const target = remote.find((item) => item.name === remoteName);
    if (!target) throw new GitWorkbenchError('branch-not-found');
    if (local.some((item) => item.name === target.branch)) throw new GitWorkbenchError('branch-exists');
    await runGit(this.repositoryPath, ['switch', '--track', target.name]);
    return this.status();
  }

  // Renomme une branche locale. `git branch -m` renomme aussi sa section de configuration : l'upstream suit. La
  // branche distante, elle, garde son nom.
  async renameBranch(name, newName) {
    await this.#ensureRepositoryPath();
    await this.#checkRefName('refs/heads/', name, 'invalid-branch-name');
    await this.#checkRefName('refs/heads/', newName, 'invalid-branch-name');
    if (!await this.#refExists(`refs/heads/${name}`)) throw new GitWorkbenchError('branch-not-found');
    if (name === newName) return this.status();
    if (await this.#refExists(`refs/heads/${newName}`)) throw new GitWorkbenchError('branch-exists');
    await runGit(this.repositoryPath, ['branch', '--move', name, newName]);
    return this.status();
  }

  // Tag sur un commit : annoté (avec message) par défaut, léger si `annotated` est faux. Un tag existant n'est jamais remplacé.
  async createTag(name, commit, { annotated = true, message = '' } = {}) {
    await this.#ensureRepositoryPath();
    await this.#checkRefName('refs/tags/', name, 'invalid-tag-name');
    const hash = await this.#resolveCommit(commit);
    if (annotated && (typeof message !== 'string' || !message.trim())) throw new GitWorkbenchError('tag-message-required');
    if (await this.#refExists(`refs/tags/${name}`)) throw new GitWorkbenchError('tag-exists');
    await runGit(this.repositoryPath, annotated ? ['tag', '--annotate', '--message', message, name, hash] : ['tag', name, hash]);
    return { name, hash, annotated: Boolean(annotated) };
  }

  // Pousse ce seul tag (jamais `--tags`) vers un dépôt distant configuré, puis vérifie qu'il y pointe sur le même objet.
  async pushTag(name, remote) {
    await this.#ensureRepositoryPath();
    await this.#checkRefName('refs/tags/', name, 'invalid-tag-name');
    const remotes = (await runGit(this.repositoryPath, ['remote'])).split('\n').filter(Boolean);
    if (typeof remote !== 'string' || !remotes.includes(remote)) throw new GitWorkbenchError('remote-not-found');
    if (!await this.#refExists(`refs/tags/${name}`)) throw new GitWorkbenchError('tag-not-found');
    const object = (await runGit(this.repositoryPath, ['rev-parse', '--verify', `refs/tags/${name}`])).trim();
    await runGit(this.repositoryPath, ['push', '--porcelain', remote, `refs/tags/${name}`]);
    const remoteRef = await runGit(this.repositoryPath, ['ls-remote', '--tags', remote, `refs/tags/${name}`]);
    const actual = remoteRef.split('\n').map((line) => line.split(/\s+/)).find(([, ref]) => ref === `refs/tags/${name}`)?.[0];
    if (actual !== object) throw new GitWorkbenchError('push-verification-failed');
    return { name, remote, hash: actual };
  }

  // Crée le commit inverse d'un commit, même déjà poussé (l'historique n'est pas réécrit). Pour un merge, `mainline`
  // désigne le parent (numéroté à partir de 1) dont on garde la version. Un conflit laisse un revert à résoudre.
  async revert(commit, mainline = null) {
    await this.#ensureRepositoryPath();
    const hash = await this.#resolveCommit(commit);
    if (await this.operation()) throw new GitWorkbenchError('operation-in-progress');
    await this.#assertClean();
    const parents = (await runGit(this.repositoryPath, ['rev-list', '--parents', '-n', '1', hash])).trim().split(' ').slice(1);
    const args = ['revert', '--no-edit'];
    if (parents.length > 1) {
      if (!Number.isInteger(mainline) || mainline < 1 || mainline > parents.length) throw new GitWorkbenchError('revert-mainline-required');
      args.push('-m', String(mainline));
    } else if (mainline !== null) throw new GitWorkbenchError('revert-mainline-invalid');
    const recoveryRef = await this.#saveRecoveryRef('revert');
    try { await runGit(this.repositoryPath, [...args, hash], { env: { GIT_EDITOR: 'true' } }); }
    catch (error) { throw new GitWorkbenchError(error.code || 'git-operation-failed', recoveryRef, 'revert'); }
    const head = (await runGit(this.repositoryPath, ['rev-parse', 'HEAD'])).trim();
    return { hash: head, recoveryRef, status: await this.status() };
  }

  // Message complet du dernier commit, proposé pour le modifier lors d'un amend.
  async headMessage() {
    await this.#ensureRepositoryPath();
    const raw = await runGit(this.repositoryPath, ['log', '-1', '--format=%B'], { acceptExitCodes: [128] }).catch(() => '');
    return raw.trimEnd();
  }

  // Le dernier commit est-il déjà sur l'upstream ? L'amender ferait alors diverger la branche de sa distante.
  async headPublished() {
    await this.#ensureRepositoryPath();
    return runGit(this.repositoryPath, ['merge-base', '--is-ancestor', 'HEAD', '@{upstream}']).then(() => true, () => false);
  }

  // Remplace le dernier commit par l'index courant et ce message. Un point de récupération garde l'ancien commit.
  async amend(message) {
    await this.#ensureRepositoryPath();
    if (typeof message !== 'string' || !message.trim()) throw new GitWorkbenchError('commit-message-required');
    if (await this.operation()) throw new GitWorkbenchError('operation-in-progress');
    const recoveryRef = await this.#saveRecoveryRef('amend');
    await runGit(this.repositoryPath, ['commit', '--amend', '-m', message]);
    const hash = (await runGit(this.repositoryPath, ['rev-parse', 'HEAD'])).trim();
    return { hash, recoveryRef };
  }

  // Versions avant/après d'un fichier du WIP pour l'éditeur de diff : index → arbre de travail, ou HEAD → index.
  async workingVersions(filePath, staged = false) {
    const entry = await this.#statusEntry(filePath);
    if (staged) {
      const [original, modified] = await Promise.all([this.#blob(`HEAD:${entry.originalPath || filePath}`), this.#blob(`:${filePath}`)]);
      return this.#versions(original, modified, { editable: false });
    }
    const [original, working] = await Promise.all([
      entry.untracked ? null : this.#blob(`:${filePath}`),
      entry.worktreeStatus === 'D' ? null : this.readWorkingFile(filePath).catch(() => null),
    ]);
    if (working?.tooLarge) return { tooLarge: true };
    if (working?.binary) return { binary: true };
    return this.#versions(original, working?.content ?? null, { editable: Boolean(working) });
  }

  // Versions d'un fichier dans un commit, comparé à son premier parent (vide pour un commit racine).
  async commitVersions(revision, filePath) {
    await this.#ensureRepositoryPath();
    const hash = await this.#resolveCommit(revision);
    const entry = (await this.#commitFiles(hash)).find((file) => file.path === filePath);
    if (!entry) throw new GitWorkbenchError('file-not-in-commit');
    const parent = (await runGit(this.repositoryPath, ['rev-list', '--parents', '-n', '1', hash])).trim().split(' ')[1];
    const [original, modified] = await Promise.all([
      parent && entry.status !== 'A' ? this.#blob(`${parent}:${entry.originalPath || filePath}`) : null,
      entry.status === 'D' ? null : this.#blob(`${hash}:${filePath}`),
    ]);
    return this.#versions(original, modified, { editable: false });
  }

  // Fichiers de l'arbre de travail pour l'explorateur de l'éditeur : suivis et non suivis, hors fichiers ignorés.
  async listFiles() {
    await this.#ensureRepositoryPath();
    const raw = await runGit(this.repositoryPath, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    return [...new Set(raw.split('\0').filter(Boolean))].filter((file) => existsSync(path.join(this.repositoryPath, file))).sort();
  }

  async readWorkingFile(filePath) {
    const absolute = await this.#workingPath(filePath);
    const info = await stat(absolute);
    if (!info.isFile()) throw new GitWorkbenchError('invalid-path');
    if (info.size > MAX_EDITABLE) return { tooLarge: true, binary: false, content: null };
    const content = await readFile(absolute, 'utf8');
    return isBinary(content) ? { binary: true, content: null } : { binary: false, content };
  }

  // N'écrit que dans un fichier texte existant du dépôt : l'éditeur ne crée ni ne supprime de fichier.
  async writeWorkingFile(filePath, content) {
    if (typeof content !== 'string') throw new GitWorkbenchError('invalid-content');
    const current = await this.readWorkingFile(filePath);
    if (current.binary || current.tooLarge) throw new GitWorkbenchError('file-not-editable');
    await writeFile(await this.#workingPath(filePath), content, 'utf8');
    return this.status();
  }

  // Les trois versions d'un fichier en conflit (base commune, côté courant, côté entrant) et le fichier avec marqueurs.
  async conflictVersions(filePath) {
    const entry = await this.#statusEntry(filePath);
    if (!entry.conflicted) throw new GitWorkbenchError('file-not-in-conflict');
    const [base, ours, theirs, working, operation] = await Promise.all([
      this.#blob(`:1:${filePath}`), this.#blob(`:2:${filePath}`), this.#blob(`:3:${filePath}`),
      this.readWorkingFile(filePath).catch(() => null), this.operation(),
    ]);
    const binary = [base, ours, theirs].some(isBinary) || Boolean(working?.binary);
    return {
      path: filePath, operation, code: entry.indexStatus + entry.worktreeStatus, binary,
      base: binary ? null : base, ours: binary ? null : ours, theirs: binary ? null : theirs,
      merged: binary ? null : working?.content ?? null,
    };
  }

  // Enregistre la résolution choisie puis marque le fichier résolu (`git add`), ou le supprime si `content` est null.
  async resolveConflict(filePath, content) {
    const entry = await this.#statusEntry(filePath);
    if (!entry.conflicted) throw new GitWorkbenchError('file-not-in-conflict');
    if (content === null) { await runGit(this.repositoryPath, ['rm', '--quiet', '--', filePath]); return this.status(); }
    if (typeof content !== 'string') throw new GitWorkbenchError('invalid-content');
    await writeFile(await this.#workingPath(filePath, { allowMissing: true }), content, 'utf8');
    await runGit(this.repositoryPath, ['add', '--', filePath]);
    return this.status();
  }

  // Reprend l'opération interrompue une fois tous les conflits résolus. GIT_EDITOR=true garde le message proposé
  // par Git (celui du commit rejoué) au lieu d'ouvrir un éditeur que personne ne verrait.
  async continueOperation() {
    const operation = await this.#pendingOperation();
    if ((await this.status()).files.some((file) => file.conflicted)) throw new GitWorkbenchError('conflicts-remaining');
    try { await runGit(this.repositoryPath, [operation, '--continue'], { env: await this.#operationEditors(operation) }); }
    catch (error) { throw new GitWorkbenchError(error.code || 'git-operation-failed', null, operation); }
    finally { await this.#cleanupRebasePlan(); }
    return { operation, status: await this.status() };
  }

  // Passe le commit en cours de rejeu (rebase, cherry-pick) : ses changements ne seront pas appliqués.
  async skipOperation() {
    const operation = await this.#pendingOperation();
    if (operation === 'merge') throw new GitWorkbenchError('operation-cannot-skip');
    try { await runGit(this.repositoryPath, [operation, '--skip'], { env: await this.#operationEditors(operation) }); }
    catch (error) { throw new GitWorkbenchError(error.code || 'git-operation-failed', null, operation); }
    finally { await this.#cleanupRebasePlan(); }
    return { operation, status: await this.status() };
  }

  async abortOperation() {
    const operation = await this.#pendingOperation();
    await runGit(this.repositoryPath, [operation, '--abort']);
    await this.#cleanupRebasePlan();
    return { operation, status: await this.status() };
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
    // Mêmes commits, dans le même ordre, que la liste que Git proposera (sans les merges, que le rebase aplatit).
    const raw = await runGit(this.repositoryPath, ['log', '--reverse', '--no-merges', '--format=%H%x00%h%x00%an%x00%at%x00%B%x1e', `${target}..HEAD`]);
    const commits = raw.split('\x1e').map((record) => record.replace(/^\n/, '')).filter(Boolean).map((record) => {
      const [hash, shortHash, author, timestamp, ...body] = record.split('\0');
      const message = body.join('\0').trimEnd();
      return { hash, shortHash, author, timestamp: Number(timestamp), subject: message.split('\n')[0], message };
    });
    return { upstream: target, commits };
  }

  async interactiveRebase(upstream, plan) {
    const { upstream: target, commits } = await this.interactiveRebaseCommits(upstream);
    await this.#assertClean();
    if (!Array.isArray(plan) || plan.length !== commits.length || new Set(plan.map((item) => item?.hash)).size !== commits.length) throw new GitWorkbenchError('invalid-rebase-plan');
    const validHashes = new Set(commits.map((item) => item.hash));
    if (plan.some((item) => !validHashes.has(item?.hash) || !REBASE_ACTIONS.includes(item.action))) throw new GitWorkbenchError('invalid-rebase-plan');
    // reword et squash portent le message final choisi (celui d'un squash est le message du groupe fusionné).
    if (plan.some((item) => (item.action === 'reword' || item.action === 'squash') && (typeof item.message !== 'string' || !item.message.trim()))) throw new GitWorkbenchError('invalid-rebase-plan');
    let previousCanFixup = false;
    for (const item of plan) {
      if ((item.action === 'fixup' || item.action === 'squash') && !previousCanFixup) throw new GitWorkbenchError('invalid-rebase-plan');
      // Une ligne écartée disparaît du todo : un « squash » qui la suit se fond dans le dernier commit gardé.
      if (item.action !== 'drop') previousCanFixup = true;
    }
    if (plan.every((item) => item.action === 'drop')) throw new GitWorkbenchError('invalid-rebase-plan');
    const steps = plan.map(({ hash, action, message }) => ((action === 'reword' || action === 'squash' || (action === 'fixup' && typeof message === 'string')) ? { hash, action, message } : { hash, action }));
    const recoveryRef = await this.#saveRecoveryRef('interactive-rebase');
    // Le plan reste dans le dossier .git tant que le rebase n'est pas terminé : après un conflit, « Continuer »
    // en a encore besoin pour appliquer les messages des reword/squash restants.
    await writeFile(await this.#rebasePlanPath(), JSON.stringify(steps), { mode: 0o600 });
    try { await runGit(this.repositoryPath, ['rebase', '--interactive', '--no-autosquash', target], { env: { ...await this.#rebaseEditors(), GIT_SEQUENCE_EDITOR: this.#rebaseEditorCommand() } }); }
    catch (error) { throw new GitWorkbenchError(error.code || 'git-operation-failed', recoveryRef, 'rebase'); }
    finally { await this.#cleanupRebasePlan(); }
    return { recoveryRef, status: await this.status() };
  }

  async #rebasePlanPath() { return path.join(await this.#gitDirectory(), 'git-workbench-rebase-plan.json'); }

  #rebaseEditorCommand() {
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const editorPath = fileURLToPath(new URL('../scripts/apply-rebase-plan.mjs', import.meta.url));
    return `${sequenceEditorRuntimePrefix()}${quote(process.execPath)} ${quote(editorPath)}`;
  }

  // Éditeur de messages : celui du plan s'il en reste un (rebase interactif lancé ici), sinon le message proposé par Git.
  async #rebaseEditors() {
    const planPath = await this.#rebasePlanPath();
    if (!existsSync(planPath)) return { GIT_EDITOR: 'true' };
    return { GIT_EDITOR: this.#rebaseEditorCommand(), GIT_WORKBENCH_REBASE_PLAN: planPath, GIT_WORKBENCH_REBASE_DONE: path.join(await this.#gitDirectory(), 'rebase-merge', 'done') };
  }

  async #cleanupRebasePlan() {
    if (await this.operation() !== 'rebase') await rm(await this.#rebasePlanPath(), { force: true });
  }

  // Contenu d'un blob (`HEAD:chemin`, `:chemin` pour l'index, `:2:chemin` pour un côté de conflit) ; null s'il n'existe pas.
  async #blob(spec) {
    if (spec.includes('\0')) throw new GitWorkbenchError('invalid-path');
    return runGit(this.repositoryPath, ['cat-file', 'blob', spec]).catch((error) => {
      if (error.code === 'git-output-too-large') throw error;
      return null;
    });
  }

  #versions(original, modified, { editable }) {
    if (isBinary(original) || isBinary(modified)) return { binary: true };
    if ((original?.length || 0) > MAX_EDITABLE || (modified?.length || 0) > MAX_EDITABLE) return { tooLarge: true };
    return { original: original ?? '', modified: modified ?? '', existsBefore: original !== null, existsAfter: modified !== null, editable };
  }

  // Chemin relatif au dépôt → chemin absolu, refusé s'il sort du dépôt (« .. », chemin absolu, lien symbolique) ou
  // s'il vise le dossier .git.
  async #workingPath(filePath, { allowMissing = false } = {}) {
    await this.#ensureRepositoryPath();
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0') || path.isAbsolute(filePath) || /^[a-z]:/i.test(filePath)) throw new GitWorkbenchError('invalid-path');
    const segments = filePath.split(/[\\/]/);
    if (segments.some((segment) => segment === '..') || segments[0].toLowerCase() === '.git') throw new GitWorkbenchError('invalid-path');
    const absolute = path.resolve(this.repositoryPath, filePath);
    const root = await realpath(this.repositoryPath);
    const real = await realpath(absolute).catch(async (error) => {
      if (!allowMissing || error.code !== 'ENOENT') throw new GitWorkbenchError('invalid-path');
      return path.join(await realpath(path.dirname(absolute)).catch(() => { throw new GitWorkbenchError('invalid-path'); }), path.basename(absolute));
    });
    if (!real.startsWith(root + path.sep)) throw new GitWorkbenchError('invalid-path');
    return absolute;
  }

  // Dossier .git du dépôt (ou de la worktree), là où Git note une opération en cours. Il ne change pas : lu une fois.
  #gitDirectoryPath = null;
  async #gitDirectory() {
    this.#gitDirectoryPath ??= path.resolve((await runGit(this.repositoryPath, ['rev-parse', '--absolute-git-dir'])).trim());
    return this.#gitDirectoryPath;
  }

  async #operationEditors(operation) {
    return operation === 'rebase' ? this.#rebaseEditors() : { GIT_EDITOR: 'true' };
  }

  async #pendingOperation() {
    await this.#ensureRepositoryPath();
    const operation = await this.operation();
    if (!operation) throw new GitWorkbenchError('no-operation');
    return operation;
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

  // Nom complet `prefixe + nom` vérifié par `git check-ref-format` (sans --branch, qui accepterait « @{-1} »).
  async #checkRefName(prefix, name, code) {
    if (typeof name !== 'string' || !name || name.length > 255 || name !== name.trim() || name.startsWith('-') || name.includes('\0')) throw new GitWorkbenchError(code);
    await runGit(this.repositoryPath, ['check-ref-format', `${prefix}${name}`]).catch(() => { throw new GitWorkbenchError(code); });
  }

  async #refExists(ref) {
    return (await runGit(this.repositoryPath, ['rev-parse', '--verify', '--quiet', ref], { acceptExitCodes: [1] })).trim() !== '';
  }

  #validateBranchName(name) {
    if (typeof name !== 'string' || !name.trim() || name.startsWith('-') || name.includes('\0')) throw new GitWorkbenchError('invalid-branch-name');
    if (name !== name.trim()) throw new GitWorkbenchError('invalid-branch-name');
  }
}
