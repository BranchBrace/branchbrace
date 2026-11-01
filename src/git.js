import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildPartialPatch, PartialStagingError, splitLines } from './partial-staging.js';

const MAX_BUFFER = 16 * 1024 * 1024;
// Au-delà, un fichier n'est ni affiché dans l'éditeur ni comparé : Monaco resterait utilisable mais la page ralentirait.
const MAX_EDITABLE = 5 * 1024 * 1024;
// Codes `XY` de `git status` d'un chemin non fusionné (conflit en cours de résolution).
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const REBASE_ACTIONS = ['pick', 'reword', 'split', 'squash', 'fixup', 'drop'];

// Blob vide : une entrée « intent-to-add » (git add -N) le désigne sans qu'il soit forcément écrit dans les objets.
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

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

// Seul l'environnement hérité est filtré : une variable passée explicitement par ce module (index temporaire d'un
// point de reprise) est voulue. `unset` retire en plus des variables, qu'elles soient héritées ou explicites.
function sanitizedEnv(extra = {}, unset = []) {
  const env = { ...process.env };
  for (const name of DANGEROUS_GIT_ENV_VARS) delete env[name];
  Object.assign(env, extra);
  for (const name of unset) delete env[name];
  return env;
}

// Identité des commits internes d'un point de reprise : jamais affichés ni poussés, ils ne doivent pas échouer dans
// un dépôt sans user.name ni user.email.
const RECOVERY_IDENTITY = {
  GIT_AUTHOR_NAME: 'BranchBrace',
  GIT_AUTHOR_EMAIL: 'branchbrace@localhost',
  GIT_COMMITTER_NAME: 'BranchBrace',
  GIT_COMMITTER_EMAIL: 'branchbrace@localhost',
};
const RECOVERY_STATE = 'refs/branchbrace/recovery-state';
// Horodatage strictement croissant : il ordonne les points de reprise, même créés dans la même milliseconde.
let lastRecoveryTime = 0;

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
      env: sanitizedEnv(options.env, options.unsetEnv),
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
      reject(new BranchBraceError('git-output-too-large'));
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
      reject(new BranchBraceError(error.code === 'ENOENT' ? 'git-missing' : 'git-launch-failed'));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      // `encoding: 'latin1'` garde les octets exacts (un caractère par octet), quel que soit l'encodage du fichier.
      const result = { stdout: Buffer.concat(stdout).toString(options.encoding || 'utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (code === 0 || options.acceptExitCodes?.includes(code)) return resolve(result.stdout);
      reject(new BranchBraceError(classifyFailure(args, result.stderr)));
    });
  });
}

function classifyFailure(allArgs, stderr) {
  // Les options `-c clé=valeur` placées avant la sous-commande ne comptent pas pour la reconnaître.
  let args = allArgs;
  while (args[0] === '-c') args = args.slice(2);
  const text = stderr.toLowerCase();
  // Une branche ne peut être extraite que dans une seule worktree (« is already used by worktree at », ou
  // « is already checked out at » avant Git 2.42).
  if (text.includes('already used by worktree') || text.includes('is already checked out at')) return 'branch-in-other-worktree';
  if (args[0] === 'worktree' && text.includes('modified or untracked files')) return 'worktree-dirty';
  if (args[0] === 'worktree' && text.includes('locked')) return 'worktree-locked';
  if (args[0] === 'worktree' && text.includes('already exists')) return 'worktree-path-exists';
  if (text.includes('conflict') || text.includes('could not apply') || text.includes('fix conflicts')) return 'conflict';
  if (args[0] === 'push' && (text.includes('rejected') || text.includes('non-fast-forward'))) return 'push-rejected';
  if (args[0] === 'push') return 'push-indeterminate';
  if (args[0] === 'fetch') return 'fetch-failed';
  if (text.includes('not a git repository')) return 'not-a-repository';  if (text.includes('local changes') || text.includes('would be overwritten')) return 'unsafe-working-tree';
  return 'git-operation-failed';
}

export class BranchBraceError extends Error {
  constructor(code, recoveryRef = null, operation = null) {
    super(recoveryRef ? `${code}; recovery=${recoveryRef}; abort with git ${operation} --abort` : code);
    this.name = 'BranchBraceError';
    this.code = code;
    this.recoveryRef = recoveryRef;
    this.operation = operation;
  }
}

// En-tête de `status --branch` : « ## main...origin/main [ahead 1] », « ## main », « ## HEAD (no branch) »
// ou « ## No commits yet on main ». Un upstream « [gone] » (branche distante supprimée) compte comme absent.
// L'avance et le retard sur l'upstream (↑ ahead, ↓ behind) se lisent dans le même en-tête.
export function parseBranchHeader(header) {
  const text = header.slice(3);
  if (text.startsWith('HEAD (no branch)')) return { branch: '(HEAD détachée)', upstream: null, ahead: 0, behind: 0 };
  const unborn = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(text);
  if (unborn) return { branch: unborn[1], upstream: null, ahead: 0, behind: 0 };
  const [names, tracking = ''] = text.split(' [');
  const [branch, upstream] = names.split('...');
  const ahead = Number(/ahead (\d+)/.exec(tracking)?.[1] || 0);
  const behind = Number(/behind (\d+)/.exec(tracking)?.[1] || 0);
  return { branch, upstream: upstream && !tracking.startsWith('gone') ? upstream : null, ahead, behind };
}

// Options d'un fetch lancé sans action de l'utilisateur. GIT_TERMINAL_PROMPT=0 ne coupe que le terminal : un
// `core.askPass` vide l'emporte sur tout programme d'invite configuré (et sur SSH_ASKPASS), et
// `credential.interactive=false` interdit à Git Credential Manager d'ouvrir une fenêtre.
export const NON_INTERACTIVE_CONFIG = ['-c', 'core.askPass=', '-c', 'credential.interactive=false'];
// Hérités du processus, ces programmes d'invite ouvriraient une fenêtre d'identifiants à chaque fetch automatique.
export const INTERACTIVE_ENV_VARS = ['GIT_ASKPASS', 'SSH_ASKPASS'];

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

// Nom du programme d'une commande SSH (« "C:\PuTTY\plink.exe" -v » → « plink »), comme Git le lit pour deviner le client.
function sshProgramName(command) {
  const match = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(command);
  const program = match ? match[1] ?? match[2] ?? match[3] : '';
  return path.posix.basename(program.replaceAll('\\', '/')).toLowerCase().replace(/\.exe$/, '');
}

// Environnement du fetch d'arrière-plan : aucune invite d'identifiants ne doit bloquer ni ouvrir de fenêtre. Un helper
// qui a déjà le secret le fournit toujours. La commande SSH effective est calculée avec la priorité de Git
// (GIT_SSH_COMMAND, puis core.sshCommand, puis GIT_SSH) puis rendue non interactive selon le client : BatchMode pour
// OpenSSH, `-batch` pour plink/PuTTY (TortoisePlink le reçoit déjà de Git). Un client inconnu n'est pas modifié.
export function nonInteractiveEnv({ sshCommand = null, sshVariant = null } = {}, environment = process.env) {
  const env = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never' };
  const command = environment.GIT_SSH_COMMAND || sshCommand || (environment.GIT_SSH ? shellQuote(environment.GIT_SSH) : 'ssh');
  const name = sshProgramName(command);
  const variant = (environment.GIT_SSH_VARIANT || sshVariant || '').toLowerCase()
    || ({ ssh: 'ssh', plink: 'plink', tortoiseplink: 'tortoiseplink' })[name] || 'auto';
  if (variant === 'plink' || variant === 'putty') Object.assign(env, { GIT_SSH_COMMAND: `${command} -batch`, GIT_SSH_VARIANT: variant });
  else if (variant === 'tortoiseplink') Object.assign(env, { GIT_SSH_COMMAND: command, GIT_SSH_VARIANT: variant });
  else if (variant === 'ssh') env.GIT_SSH_COMMAND = `${command} -o BatchMode=yes`;
  return env;
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

// Partie « identifiants@ » d'une URL de remote, en forme complète (schéma://…@) ou scp (…@hôte:chemin).
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]+)@/i;
const SCP_USERINFO = /^([^@/\s]+)@(?=[a-z0-9.-]+:(?!\/\/))/i;

// Identifiants dans une URL de remote : « utilisateur:secret@ » quel que soit le protocole, ou toute partie « …@ » d'une
// URL non SSH, car un jeton seul (« ghp_xxx@github.com ») ne se distingue pas d'un nom. Un utilisateur SSH
// (« git@hôte:chemin », « ssh://git@hôte/… ») n'est pas un secret.
export function remoteUrlHasCredentials(url) {
  if (typeof url !== 'string') return false;
  const full = URL_USERINFO.exec(url);
  if (full) return full[2].includes(':') || !/^(?:ssh|git\+ssh|ssh\+git):\/\/$/i.test(full[1]);
  return SCP_USERINFO.exec(url)?.[1].includes(':') ?? false;
}

// URL de remote affichable : les identifiants d'une URL déjà configurée sont retirés, comme pour sa page web (B1).
export function redactRemoteUrl(url) {
  if (!remoteUrlHasCredentials(url)) return url;
  return URL_USERINFO.test(url) ? url.replace(URL_USERINFO, '$1') : url.replace(SCP_USERINFO, '');
}

// URL saisie pour un remote. Les identifiants sont refusés (A10) : ils resteraient en clair dans .git/config. Les
// transports ext:: et fd:: lancent une commande ou lisent un descripteur : jamais utiles à un remote saisi ici.
function validateRemoteUrl(url) {
  if (typeof url !== 'string' || !url || url !== url.trim() || url.length > 2048 || url.startsWith('-') || /[\0\r\n]/.test(url)) throw new BranchBraceError('invalid-remote-url');
  if (/^(?:ext|fd)::/i.test(url)) throw new BranchBraceError('invalid-remote-url');
  if (remoteUrlHasCredentials(url)) throw new BranchBraceError('remote-url-credentials');
}

// Deux chemins désignent-ils le même dossier ? Git écrit « C:/x » sous Windows, où la casse ne compte pas.
export function samePath(a, b) {
  const normalize = (value) => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  return normalize(a) === normalize(b);
}

// `child` est-il `parent` lui-même ou un chemin à l'intérieur ?
export function isInside(child, parent) {
  const normalize = (value) => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  const relative = path.relative(normalize(parent), normalize(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// `git worktree list --porcelain -z` : un attribut par champ, une worktree par bloc terminé par un champ vide. La
// première est la worktree principale ; `current` désigne celle du dépôt ouvert. Sans `-z` (Git < 2.36), les champs
// sont séparés par des retours à la ligne : `separator` vaut alors '\n'.
export function parseWorktrees(raw, currentPath, separator = '\0') {
  const worktrees = [];
  let item = null;
  for (const field of raw.split(separator).map((value) => (separator === '\n' ? value.replace(/\r$/, '') : value))) {
    if (!field) { item = null; continue; }
    const [key, ...rest] = field.split(' ');
    const value = rest.join(' ');
    if (key === 'worktree') {
      item = { path: path.resolve(value), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false, main: !worktrees.length, current: samePath(value, currentPath) };
      worktrees.push(item);
    } else if (!item) continue;
    else if (key === 'HEAD') item.head = value;
    else if (key === 'branch') item.branch = value.startsWith('refs/heads/') ? value.slice(11) : value;
    else if (key === 'detached') item.detached = true;
    else if (key === 'bare') item.bare = true;
    else if (key === 'locked') item.locked = value || true;
    else if (key === 'prunable') item.prunable = value || true;
  }
  return worktrees;
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
    return { ...parseStatus(raw), operation, split: operation === 'rebase' ? await this.#splitState() : null };
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
  // En arrière-plan (`background`), le fetch est sauté si un fetch ou un pull est en cours ou attend son tour, ou si
  // une opération Git (rebase, merge, cherry-pick) attend d'être terminée, et ne peut jamais demander d'identifiants.
  // Le test « en vol » et la prise du verrou sont synchrones : aucun appel ne peut se glisser entre les deux.
  fetch({ background = false } = {}) {
    if (background && this.#syncPending) return Promise.resolve({ skipped: 'in-flight' });
    return this.#exclusiveSync(async () => {
      await this.#ensureRepositoryPath();
      if (background) {
        const operation = await this.operation();
        if (operation) return { skipped: 'operation', operation };
      }
      const args = ['fetch', '--all', '--prune', '--no-recurse-submodules'];
      if (!background) await runGit(this.repositoryPath, args);
      else await runGit(this.repositoryPath, [...NON_INTERACTIVE_CONFIG, ...args], { env: nonInteractiveEnv(await this.#sshSettings()), unsetEnv: INTERACTIVE_ENV_VARS });
      return { skipped: null };
    });
  }

  // Fetch et pull écrivent les mêmes références de suivi : ils passent un par un dans l'ordre d'arrivée (deux fetch
  // simultanés échoueraient sur « cannot lock ref »). `#syncPending` compte les tâches en cours ou en attente.
  #syncQueue = Promise.resolve();
  #syncPending = 0;
  #exclusiveSync(task) {
    this.#syncPending += 1;
    const run = this.#syncQueue.then(task).finally(() => { this.#syncPending -= 1; });
    this.#syncQueue = run.catch(() => {});
    return run;
  }

  async #sshSettings() {
    const read = (key) => runGit(this.repositoryPath, ['config', '--get', key], { acceptExitCodes: [1] }).then((value) => value.trim() || null);
    const [sshCommand, sshVariant] = await Promise.all([read('core.sshCommand'), read('ssh.variant')]);
    return { sshCommand, sshVariant };
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
        '--decorate=full', '--decorate-refs-exclude=refs/branchbrace/*',
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
    if (!entry) throw new BranchBraceError('file-not-in-commit');
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

  // Indexation partielle (A3). `request` décrit le diff affiché : `original` et `modified` tels que renvoyés par
  // workingVersions, `changes` les blocs calculés par Monaco, `selection` les lignes choisies de chaque côté. Le patch
  // passe par `git apply --cached` ; l'index est ensuite relu et restauré s'il diffère du résultat attendu.
  // L'arbre de travail n'est jamais modifié (A11).
  async stageLines(filePath, request) { return this.#applyLines(filePath, request, 'stage'); }

  async unstageLines(filePath, request) { return this.#applyLines(filePath, request, 'unstage'); }

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
    if (typeof message !== 'string' || !message.trim()) throw new BranchBraceError('commit-message-required');
    const staged = await runGit(this.repositoryPath, ['diff', '--cached', '--quiet']).then(() => false).catch((error) => {
      if (error.code === 'git-operation-failed') return true;
      throw error;
    });
    if (!staged) throw new BranchBraceError('nothing-staged');
    await runGit(this.repositoryPath, ['commit', '-m', message]);
    return runGit(this.repositoryPath, ['rev-parse', 'HEAD']).then((hash) => hash.trim());
  }

  async push(expectedUpstream) {
    await this.#ensureRepositoryPath();
    const { upstream, remote, branch } = await this.#upstreamTarget(expectedUpstream);
    const before = (await runGit(this.repositoryPath, ['rev-parse', 'HEAD'])).trim();
    await runGit(this.repositoryPath, ['push', '--porcelain', remote, `HEAD:refs/heads/${branch}`]);
    return { upstream, hash: await this.#verifyRemoteBranch(remote, branch, before) };
  }

  // Ce qu'un push forcé ferait disparaître de l'upstream : les commits de sa copie locale (dernier fetch) absents de
  // HEAD. Cette copie est le « lease » : le push forcé n'écrase la branche distante que si elle pointe encore dessus.
  async forcePushPreview(expectedUpstream) {
    await this.#ensureRepositoryPath();
    if (!expectedUpstream) throw new BranchBraceError('upstream-missing');
    const { upstream } = await this.#upstreamTarget(expectedUpstream);
    const lease = (await runGit(this.repositoryPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/remotes/${upstream}^{commit}`]).catch(() => '')).trim();
    if (!lease) throw new BranchBraceError('upstream-missing');
    const head = (await runGit(this.repositoryPath, ['rev-parse', 'HEAD'])).trim();
    const [raw, count] = await Promise.all([
      runGit(this.repositoryPath, ['log', '-n', '50', '--format=%H%x00%h%x00%an%x00%s', `${head}..${lease}`]),
      runGit(this.repositoryPath, ['rev-list', '--count', `${head}..${lease}`]),
    ]);
    const dropped = raw.split('\n').filter(Boolean).map((line) => {
      const [hash, shortHash, author, ...subject] = line.split('\0');
      return { hash, shortHash, author, subject: subject.join('\0') };
    });
    return { upstream, lease, head, dropped, droppedCount: Number(count.trim()) };
  }

  // Push forcé vers l'upstream affiché, toujours avec `--force-with-lease` sur la valeur attendue explicite : si la
  // branche distante a bougé depuis `lease`, Git refuse et rien n'est écrasé. Jamais lancé en repli d'un push refusé.
  async forcePush(expectedUpstream, lease) {
    await this.#ensureRepositoryPath();
    if (!expectedUpstream) throw new BranchBraceError('upstream-missing');
    if (typeof lease !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(lease)) throw new BranchBraceError('invalid-revision');
    const { upstream, remote, branch } = await this.#upstreamTarget(expectedUpstream);
    const head = (await runGit(this.repositoryPath, ['rev-parse', 'HEAD'])).trim();
    const target = `refs/heads/${branch}`;
    // Aucun point de reprise n'existe côté serveur : celui-ci garde ici les commits distants que le push va remplacer.
    const recoveryRef = `refs/branchbrace/recovery/force-push-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await runGit(this.repositoryPath, ['update-ref', recoveryRef, lease]);
    // --porcelain : l'issue de la ref se lit sur stdout (« ! » = refusée, « (stale info) » = lease périmé). Git sort
    // alors en 1 ; une coupure réseau sort en 128 et reste indéterminée. Le succès n'est retenu qu'après relecture distante.
    const output = await runGit(this.repositoryPath, ['push', '--porcelain', `--force-with-lease=${target}:${lease}`, remote, `HEAD:${target}`], { acceptExitCodes: [1] })
      .catch((error) => { throw new BranchBraceError(error.code, recoveryRef); });
    const [flag, , summary = ''] = output.split('\n').map((line) => line.split('\t')).find((fields) => fields[1]?.endsWith(`:${target}`)) || [];
    if (!flag) throw new BranchBraceError('push-indeterminate', recoveryRef);
    if (flag === '!') {
      await runGit(this.repositoryPath, ['update-ref', '-d', recoveryRef]);
      throw new BranchBraceError(summary.includes('stale info') ? 'force-push-stale' : 'push-rejected');
    }
    const hash = await this.#verifyRemoteBranch(remote, branch, head).catch((error) => { throw new BranchBraceError(error.code, recoveryRef); });
    return { upstream, hash, previous: lease, recoveryRef };
  }

  // Upstream de la branche courante, découpé en remote et branche distante ; refusé s'il diffère de celui affiché.
  async #upstreamTarget(expectedUpstream) {
    const upstream = (await runGit(this.repositoryPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch((error) => {
      if (error.code === 'git-operation-failed') throw new BranchBraceError('upstream-missing');
      throw error;
    })).trim();
    if (expectedUpstream && upstream !== expectedUpstream) throw new BranchBraceError('upstream-changed');
    const currentBranch = (await runGit(this.repositoryPath, ['branch', '--show-current'])).trim();
    if (!currentBranch) throw new BranchBraceError('upstream-missing');
    const remote = (await runGit(this.repositoryPath, ['config', '--get', `branch.${currentBranch}.remote`])).trim();
    if (!remote || !upstream.startsWith(`${remote}/`)) throw new BranchBraceError('upstream-missing');
    return { upstream, remote, branch: upstream.slice(remote.length + 1) };
  }

  // Un push n'est réussi que si la branche distante, relue sur le serveur, pointe sur le commit poussé (A7).
  async #verifyRemoteBranch(remote, branch, expected) {
    const remoteRef = await runGit(this.repositoryPath, ['ls-remote', '--heads', remote, `refs/heads/${branch}`]);
    const actual = remoteRef.trim().split(/\s+/)[0];
    if (!actual || actual !== expected) throw new BranchBraceError('push-verification-failed');
    return actual;
  }

  // Dépôts distants configurés. L'URL renvoyée est sans identifiants : le secret d'une URL déjà configurée ne quitte
  // pas ce module, `credentials` signale seulement qu'il faut la changer.
  async remotes() {
    await this.#ensureRepositoryPath();
    const raw = await runGit(this.repositoryPath, ['config', '--get-regexp', '^remote\\..*\\.url$'], { acceptExitCodes: [1] });
    return raw.split('\n').filter(Boolean).map((line) => {
      const [key, ...value] = line.split(' ');
      const url = value.join(' ');
      return { name: key.slice(7, -4), url: redactRemoteUrl(url), credentials: remoteUrlHasCredentials(url) };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  async addRemote(name, url) {
    await this.#ensureRepositoryPath();
    await this.#validateRemoteName(name);
    validateRemoteUrl(url);
    if ((await this.remotes()).some((item) => item.name === name)) throw new BranchBraceError('remote-exists');
    await runGit(this.repositoryPath, ['remote', 'add', '--', name, url]);
    return this.remotes();
  }

  // Git déplace aussi les branches distantes suivies et l'upstream des branches locales qui suivaient ce remote.
  async renameRemote(name, newName) {
    await this.#ensureRepositoryPath();
    await this.#validateRemoteName(newName);
    const remotes = await this.remotes();
    if (!remotes.some((item) => item.name === name)) throw new BranchBraceError('remote-not-found');
    if (remotes.some((item) => item.name === newName)) throw new BranchBraceError('remote-exists');
    await runGit(this.repositoryPath, ['remote', 'rename', '--', name, newName]);
    return this.remotes();
  }

  async setRemoteUrl(name, url) {
    await this.#ensureRepositoryPath();
    validateRemoteUrl(url);
    if (!(await this.remotes()).some((item) => item.name === name)) throw new BranchBraceError('remote-not-found');
    await runGit(this.repositoryPath, ['remote', 'set-url', '--', name, url]);
    return this.remotes();
  }

  // Retire le remote de la configuration et ses branches distantes de cet ordinateur ; rien ne change sur le serveur.
  async removeRemote(name) {
    await this.#ensureRepositoryPath();
    if (!(await this.remotes()).some((item) => item.name === name)) throw new BranchBraceError('remote-not-found');
    await runGit(this.repositoryPath, ['remote', 'remove', '--', name]);
    return this.remotes();
  }

  // Même règle que Git (« refs/remotes/<nom>/… » doit être une référence valide), sans laisser un nom passer pour une option.
  async #validateRemoteName(name) {
    if (typeof name !== 'string' || !name || name !== name.trim() || name.length > 255 || name.startsWith('-') || /[\0\s]/.test(name)) throw new BranchBraceError('invalid-remote-name');
    await runGit(this.repositoryPath, ['check-ref-format', `refs/remotes/${name}/test`]).catch(() => { throw new BranchBraceError('invalid-remote-name'); });
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

  // Renomme une branche locale (`branch -m`, jamais `-M` : un nom déjà pris est refusé). Git déplace aussi sa
  // configuration, donc son upstream. Avec `remote`, la branche distante suivie est renommée de la même façon : le
  // nouveau nom est poussé puis vérifié, l'upstream le suit, et l'ancien nom n'est supprimé du dépôt distant que s'il
  // pointe encore exactement sur le commit qui vient d'être copié : aucun commit distant ne peut être perdu.
  async renameBranch(oldName, newName, { remote = false } = {}) {
    await this.#ensureRepositoryPath();
    this.#validateBranchName(oldName);
    await this.#checkBranchName(newName);
    const { local } = await this.references();
    const branch = local.find((item) => item.name === oldName);
    if (!branch) throw new BranchBraceError('branch-not-found');
    if (oldName === newName) return { branch: newName, remote: null };
    if (local.some((item) => item.name === newName)) throw new BranchBraceError('branch-name-taken');
    const target = remote ? await this.#remoteRenameTarget(branch, newName) : null;
    await runGit(this.repositoryPath, ['branch', '-m', '--', oldName, newName]);
    if (!target) return { branch: newName, remote: null };
    // La branche est déjà renommée en local : un échec de publication le dit explicitement, pour que la vue suive
    // le nouveau nom.
    try {
      await runGit(this.repositoryPath, ['push', '--porcelain', target.remote, `refs/heads/${newName}:refs/heads/${newName}`]);
      if (await this.#remoteHead(target.remote, newName) !== branch.hash) throw new Error('verification');
      // L'upstream est écrit dans la configuration plutôt que par `--set-upstream-to` : celui-ci exige le ref
      // `<remote>/<nom>`, absent d'un clone single-branch.
      await runGit(this.repositoryPath, ['config', `branch.${newName}.remote`, target.remote]);
      await runGit(this.repositoryPath, ['config', `branch.${newName}.merge`, `refs/heads/${newName}`]);
    } catch { throw new BranchBraceError('remote-rename-publish-failed'); }
    const renamed = { name: target.remote, from: target.branch, to: newName };
    try {
      await runGit(this.repositoryPath, ['push', '--porcelain', `--force-with-lease=refs/heads/${target.branch}:${branch.hash}`, target.remote, `:refs/heads/${target.branch}`]);
    } catch { return { branch: newName, remote: { ...renamed, oldBranchKept: true } }; }
    return { branch: newName, remote: renamed };
  }

  // Branche distante à renommer avec la locale : elle doit exister, pointer sur le même commit (sinon des commits
  // seraient d'un seul côté) et le nouveau nom doit être libre sur le serveur.
  async #remoteRenameTarget(branch, newName) {
    if (!branch.upstream || branch.gone) throw new BranchBraceError('upstream-missing');
    const remote = (await runGit(this.repositoryPath, ['config', '--get', `branch.${branch.name}.remote`], { acceptExitCodes: [1] })).trim();
    const merge = (await runGit(this.repositoryPath, ['config', '--get', `branch.${branch.name}.merge`], { acceptExitCodes: [1] })).trim();
    if (!remote || remote === '.' || !merge.startsWith('refs/heads/')) throw new BranchBraceError('upstream-missing');
    const target = { remote, branch: merge.slice(11) };
    const [current, taken] = await Promise.all([this.#remoteHead(remote, target.branch), this.#remoteHead(remote, newName)]);
    if (current !== branch.hash) throw new BranchBraceError('remote-rename-diverged');
    if (taken) throw new BranchBraceError('branch-name-taken-remote');
    return target;
  }

  async #remoteHead(remote, branch) {
    const raw = await runGit(this.repositoryPath, ['ls-remote', '--heads', remote, `refs/heads/${branch}`]).catch(() => { throw new BranchBraceError('fetch-failed'); });
    return raw.split('\n').map((line) => line.split(/\s+/)).find(([, ref]) => ref === `refs/heads/${branch}`)?.[0] ?? null;
  }

  // `check-ref-format --branch` valide le nom selon les règles de Git ; il développe aussi « @{-1} » en nom réel,
  // qu'on refuse : le nom saisi doit être exactement celui qui sera créé.
  async #checkBranchName(name) {
    this.#validateBranchName(name);
    const checked = await runGit(this.repositoryPath, ['check-ref-format', '--branch', name]).catch(() => { throw new BranchBraceError('invalid-branch-name'); });
    if (checked.trim() !== name) throw new BranchBraceError('invalid-branch-name');
  }

  // `-z` n'existe que depuis Git 2.36 : sans lui, la sortie ligne à ligne est lue à la place. Si Git ne sait pas du
  // tout lister les worktrees, la liste est vide : le dépôt s'ouvre quand même (références et instantané en dépendent).
  async worktrees() {
    await this.#ensureRepositoryPath();
    try {
      return parseWorktrees(await runGit(this.repositoryPath, ['worktree', 'list', '--porcelain', '-z']), this.repositoryPath);
    } catch {
      try {
        return parseWorktrees(await runGit(this.repositoryPath, ['worktree', 'list', '--porcelain']), this.repositoryPath, '\n');
      } catch { return []; }
    }
  }

  // Nouvelle worktree dans `target` (absent ou vide), sur une branche existante qui n'est extraite nulle part, ou sur
  // une nouvelle branche créée depuis `startPoint` (HEAD par défaut).
  async addWorktree(target, { branch, newBranch = false, startPoint = null } = {}) {
    await this.#ensureRepositoryPath();
    if (typeof target !== 'string' || !target || target.includes('\0') || !path.isAbsolute(target)) throw new BranchBraceError('invalid-path');
    const destination = path.resolve(target);
    // Une worktree imbriquée dans une autre y apparaîtrait comme un dossier non suivi (et serait committable).
    if ((await this.worktrees()).some((item) => isInside(destination, item.path))) throw new BranchBraceError('worktree-path-inside-worktree');
    if (existsSync(destination) && (await readdir(destination).catch(() => { throw new BranchBraceError('worktree-path-exists'); })).length) throw new BranchBraceError('worktree-path-exists');
    if (newBranch) {
      await this.#checkBranchName(branch);
      if ((await this.branches()).some((item) => item.name === branch)) throw new BranchBraceError('branch-name-taken');
      const base = startPoint ? await this.#resolveCommit(startPoint) : 'HEAD';
      await runGit(this.repositoryPath, ['worktree', 'add', '--quiet', '-b', branch, '--', destination, base]);
    } else {
      this.#validateBranchName(branch);
      if (!(await this.branches()).some((item) => item.name === branch)) throw new BranchBraceError('branch-not-found');
      if ((await this.worktrees()).some((item) => item.branch === branch)) throw new BranchBraceError('branch-in-other-worktree');
      await runGit(this.repositoryPath, ['worktree', 'add', '--quiet', '--', destination, branch]);
    }
    return { path: destination, branch };
  }

  // Supprime une worktree liée sans `--force` : Git refuse s'il y reste des changements non commités ou des fichiers
  // non suivis, qui seraient perdus. Sa branche est conservée. Une worktree dont le dossier a disparu est seulement
  // oubliée : seules ses métadonnées sont effacées, jamais celles des autres (un `prune` global oublierait aussi une
  // worktree sur un disque momentanément débranché).
  async removeWorktree(target) {
    const worktree = (await this.worktrees()).find((item) => typeof target === 'string' && samePath(item.path, target));
    if (!worktree) throw new BranchBraceError('worktree-not-found');
    if (worktree.main) throw new BranchBraceError('worktree-main');
    if (worktree.current) throw new BranchBraceError('worktree-current');
    if (worktree.locked) throw new BranchBraceError('worktree-locked');
    if (worktree.prunable) await this.#forgetWorktree(worktree.path);
    else await runGit(this.repositoryPath, ['worktree', 'remove', '--', worktree.path]);
    return this.worktrees();
  }

  // Efface `.git/worktrees/<id>` de la seule worktree introuvable visée : celle dont le fichier `gitdir` désigne
  // `<chemin>/.git`. Refusé si son dossier est de nouveau présent.
  async #forgetWorktree(worktreePath) {
    if (existsSync(worktreePath)) throw new BranchBraceError('worktree-not-found');
    const common = path.resolve(this.repositoryPath, (await runGit(this.repositoryPath, ['rev-parse', '--git-common-dir'])).trim());
    const admin = path.join(common, 'worktrees');
    for (const entry of await readdir(admin).catch(() => [])) {
      const gitdir = (await readFile(path.join(admin, entry, 'gitdir'), 'utf8').catch(() => '')).trim();
      if (!gitdir || !samePath(path.dirname(path.resolve(admin, entry, gitdir)), worktreePath)) continue;
      await rm(path.join(admin, entry), { recursive: true, force: true });
      return;
    }
    throw new BranchBraceError('worktree-not-found');
  }

  async pruneWorktrees() {
    await this.#ensureRepositoryPath();
    await runGit(this.repositoryPath, ['worktree', 'prune']);
    return this.worktrees();
  }

  async references() {
    await this.#ensureRepositoryPath();
    const [raw, urls, worktrees] = await Promise.all([
      runGit(this.repositoryPath, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)', 'refs/heads', 'refs/remotes', 'refs/tags']),
      runGit(this.repositoryPath, ['config', '--get-regexp', '^remote\\..*\\.url$'], { acceptExitCodes: [1] }),
      this.worktrees(),
    ]);
    // Dépôts distants configurés et leur page web : l'URL Git brute (qui peut contenir un jeton) ne quitte pas ce module.
    const remotes = urls.split('\n').filter(Boolean).map((line) => {
      const [key, ...value] = line.split(' ');
      return { name: key.slice(7, -4), ...(remoteWebUrl(value.join(' ')) || { host: null, path: null, provider: 'git', web: null }) };
    }).sort((a, b) => b.name.length - a.name.length);
    const result = { local: [], remote: [], tags: [], remotes: [], worktrees };
    for (const line of raw.split('\n').filter(Boolean)) {
      // %(*objectname) est le commit pointé par un tag annoté.
      const [ref, object, peeled, head, upstream, track] = line.split('\0');
      const hash = peeled || object;
      if (ref.startsWith('refs/heads/')) {
        const ahead = Number(/ahead (\d+)/.exec(track)?.[1] || 0);
        const behind = Number(/behind (\d+)/.exec(track)?.[1] || 0);
        // Branche extraite dans une autre worktree : Git refuse d'y basculer ici, l'interface propose d'ouvrir celle-ci.
        const elsewhere = worktrees.find((item) => item.branch === ref.slice(11) && !item.current);
        result.local.push({ name: ref.slice(11), hash, current: head === '*', upstream: upstream || null, gone: track === 'gone', ahead, behind, worktree: elsewhere?.path ?? null });
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
    if (!branches.some((branch) => branch.name === name)) throw new BranchBraceError('branch-not-found');
    if ((await this.worktrees()).some((item) => item.branch === name && !item.current)) throw new BranchBraceError('branch-in-other-worktree');
    await runGit(this.repositoryPath, ['switch', name]);
    return this.status();
  }

  // Branche présente seulement sur le dépôt distant : crée la branche locale du même nom qui la suit, puis bascule.
  async checkoutRemote(remoteName) {
    await this.#ensureRepositoryPath();
    const { local, remote } = await this.references();
    const target = remote.find((item) => item.name === remoteName);
    if (!target) throw new BranchBraceError('branch-not-found');
    if (local.some((item) => item.name === target.branch)) throw new BranchBraceError('branch-exists');
    await runGit(this.repositoryPath, ['switch', '--track', target.name]);
    return this.status();
  }

  // Tag sur un commit : annoté (avec message) par défaut, léger si `annotated` est faux. Un tag existant n'est jamais remplacé.
  async createTag(name, commit, { annotated = true, message = '' } = {}) {
    await this.#ensureRepositoryPath();
    await this.#checkRefName('refs/tags/', name, 'invalid-tag-name');
    const hash = await this.#resolveCommit(commit);
    if (annotated && (typeof message !== 'string' || !message.trim())) throw new BranchBraceError('tag-message-required');
    if (await this.#refExists(`refs/tags/${name}`)) throw new BranchBraceError('tag-exists');
    await runGit(this.repositoryPath, annotated ? ['tag', '--annotate', '--message', message, name, hash] : ['tag', name, hash]);
    return { name, hash, annotated: Boolean(annotated) };
  }

  // Pousse ce seul tag (jamais `--tags`) vers un dépôt distant configuré, puis vérifie qu'il y pointe sur le même objet.
  async pushTag(name, remote) {
    await this.#ensureRepositoryPath();
    await this.#checkRefName('refs/tags/', name, 'invalid-tag-name');
    const remotes = (await runGit(this.repositoryPath, ['remote'])).split('\n').filter(Boolean);
    if (typeof remote !== 'string' || !remotes.includes(remote)) throw new BranchBraceError('remote-not-found');
    if (!await this.#refExists(`refs/tags/${name}`)) throw new BranchBraceError('tag-not-found');
    const object = (await runGit(this.repositoryPath, ['rev-parse', '--verify', `refs/tags/${name}`])).trim();
    await runGit(this.repositoryPath, ['push', '--porcelain', remote, `refs/tags/${name}`]);
    const remoteRef = await runGit(this.repositoryPath, ['ls-remote', '--tags', remote, `refs/tags/${name}`]);
    const actual = remoteRef.split('\n').map((line) => line.split(/\s+/)).find(([, ref]) => ref === `refs/tags/${name}`)?.[0];
    if (actual !== object) throw new BranchBraceError('push-verification-failed');
    return { name, remote, hash: actual };
  }

  // Crée le commit inverse d'un commit, même déjà poussé (l'historique n'est pas réécrit). Pour un merge, `mainline`
  // désigne le parent (numéroté à partir de 1) dont on garde la version. Un conflit laisse un revert à résoudre.
  async revert(commit, mainline = null) {
    await this.#ensureRepositoryPath();
    const hash = await this.#resolveCommit(commit);
    if (await this.operation()) throw new BranchBraceError('operation-in-progress');
    await this.#assertClean();
    const parents = (await runGit(this.repositoryPath, ['rev-list', '--parents', '-n', '1', hash])).trim().split(' ').slice(1);
    const args = ['revert', '--no-edit'];
    if (parents.length > 1) {
      if (!Number.isInteger(mainline) || mainline < 1 || mainline > parents.length) throw new BranchBraceError('revert-mainline-required');
      args.push('-m', String(mainline));
    } else if (mainline !== null) throw new BranchBraceError('revert-mainline-invalid');
    const recoveryRef = await this.#saveRecoveryRef('revert');
    try { await runGit(this.repositoryPath, [...args, hash], { env: { GIT_EDITOR: 'true' } }); }
    catch (error) { throw new BranchBraceError(error.code || 'git-operation-failed', recoveryRef, 'revert'); }
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
    if (typeof message !== 'string' || !message.trim()) throw new BranchBraceError('commit-message-required');
    if (await this.operation()) throw new BranchBraceError('operation-in-progress');
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
    if (!entry) throw new BranchBraceError('file-not-in-commit');
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
    if (!info.isFile()) throw new BranchBraceError('invalid-path');
    if (info.size > MAX_EDITABLE) return { tooLarge: true, binary: false, content: null };
    const content = await readFile(absolute, 'utf8');
    return isBinary(content) ? { binary: true, content: null } : { binary: false, content };
  }

  // N'écrit que dans un fichier texte existant du dépôt : l'éditeur ne crée ni ne supprime de fichier.
  async writeWorkingFile(filePath, content) {
    if (typeof content !== 'string') throw new BranchBraceError('invalid-content');
    const current = await this.readWorkingFile(filePath);
    if (current.binary || current.tooLarge) throw new BranchBraceError('file-not-editable');
    await writeFile(await this.#workingPath(filePath), content, 'utf8');
    return this.status();
  }

  // Les trois versions d'un fichier en conflit (base commune, côté courant, côté entrant) et le fichier avec marqueurs.
  async conflictVersions(filePath) {
    const entry = await this.#statusEntry(filePath);
    if (!entry.conflicted) throw new BranchBraceError('file-not-in-conflict');
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
    if (!entry.conflicted) throw new BranchBraceError('file-not-in-conflict');
    if (content === null) { await runGit(this.repositoryPath, ['rm', '--quiet', '--', filePath]); return this.status(); }
    if (typeof content !== 'string') throw new BranchBraceError('invalid-content');
    await writeFile(await this.#workingPath(filePath, { allowMissing: true }), content, 'utf8');
    await runGit(this.repositoryPath, ['add', '--', filePath]);
    return this.status();
  }

  // Reprend l'opération interrompue une fois tous les conflits résolus. GIT_EDITOR=true garde le message proposé
  // par Git (celui du commit rejoué) au lieu d'ouvrir un éditeur que personne ne verrait.
  async continueOperation() {
    const operation = await this.#pendingOperation();
    const status = await this.status();
    if (status.files.some((file) => file.conflicted)) throw new BranchBraceError('conflicts-remaining');
    // Pendant un découpage, Git refuserait de continuer avec des changements non commités : on l'explique avant.
    if (status.split && status.files.length) throw new BranchBraceError('split-changes-remaining');
    try { await runGit(this.repositoryPath, [operation, '--continue'], { env: await this.#operationEditors(operation) }); }
    catch (error) { throw new BranchBraceError(error.code || 'git-operation-failed', null, operation); }
    finally { await this.#cleanupRebasePlan(); }
    await this.#prepareSplitStop();
    return { operation, status: await this.status() };
  }

  // Passe le commit en cours de rejeu (rebase, cherry-pick) : ses changements ne seront pas appliqués.
  async skipOperation() {
    const operation = await this.#pendingOperation();
    if (operation === 'merge') throw new BranchBraceError('operation-cannot-skip');
    try { await runGit(this.repositoryPath, [operation, '--skip'], { env: await this.#operationEditors(operation) }); }
    catch (error) { throw new BranchBraceError(error.code || 'git-operation-failed', null, operation); }
    finally { await this.#cleanupRebasePlan(); }
    await this.#prepareSplitStop();
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
    catch (error) { throw new BranchBraceError(error.code || 'git-operation-failed', recoveryRef, 'cherry-pick'); }
    return { recoveryRef, status: await this.status() };
  }

  async rebase(upstream) {
    const target = await this.#resolveCommit(upstream);
    await this.#assertClean();
    const recoveryRef = await this.#saveRecoveryRef('rebase');
    try { await runGit(this.repositoryPath, ['rebase', target]); }
    catch (error) { throw new BranchBraceError(error.code || 'git-operation-failed', recoveryRef, 'rebase'); }
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
    if (!Array.isArray(plan) || plan.length !== commits.length || new Set(plan.map((item) => item?.hash)).size !== commits.length) throw new BranchBraceError('invalid-rebase-plan');
    const validHashes = new Set(commits.map((item) => item.hash));
    if (plan.some((item) => !validHashes.has(item?.hash) || !REBASE_ACTIONS.includes(item.action))) throw new BranchBraceError('invalid-rebase-plan');
    // reword et squash portent le message final choisi (celui d'un squash est le message du groupe fusionné).
    if (plan.some((item) => (item.action === 'reword' || item.action === 'squash') && (typeof item.message !== 'string' || !item.message.trim()))) throw new BranchBraceError('invalid-rebase-plan');
    let previousCanFixup = false;
    for (const item of plan) {
      if ((item.action === 'fixup' || item.action === 'squash') && !previousCanFixup) throw new BranchBraceError('invalid-rebase-plan');
      // Une ligne écartée disparaît du todo : un « squash » qui la suit se fond dans le dernier commit gardé.
      if (item.action !== 'drop') previousCanFixup = true;
    }
    if (plan.every((item) => item.action === 'drop')) throw new BranchBraceError('invalid-rebase-plan');
    const steps = plan.map(({ hash, action, message }) => ((action === 'reword' || action === 'squash' || (action === 'fixup' && typeof message === 'string')) ? { hash, action, message } : { hash, action }));
    const recoveryRef = await this.#saveRecoveryRef('interactive-rebase');
    // Le plan reste dans le dossier .git tant que le rebase n'est pas terminé : après un conflit, « Continuer »
    // en a encore besoin pour appliquer les messages des reword/squash restants.
    await writeFile(await this.#rebasePlanPath(), JSON.stringify(steps), { mode: 0o600 });
    try { await runGit(this.repositoryPath, ['rebase', '--interactive', '--no-autosquash', target], { env: { ...await this.#rebaseEditors(), GIT_SEQUENCE_EDITOR: this.#rebaseEditorCommand() } }); }
    catch (error) { throw new BranchBraceError(error.code || 'git-operation-failed', recoveryRef, 'rebase'); }
    finally { await this.#cleanupRebasePlan(); }
    await this.#prepareSplitStop();
    return { recoveryRef, status: await this.status() };
  }

  // Découpe un commit de la branche courante : rebase interactif qui s'arrête sur lui (les commits suivants restent
  // « gardés »), puis retrait de ce seul commit pour que ses changements reviennent, non indexés, dans l'arbre de
  // travail. On les recommitte en plusieurs morceaux, puis « Continuer » rejoue la suite de la branche.
  async splitCommit(revision) {
    await this.#ensureRepositoryPath();
    const hash = await this.#resolveCommit(revision);
    const parents = (await runGit(this.repositoryPath, ['rev-list', '--parents', '-n', '1', hash])).trim().split(' ').slice(1);
    // Un commit racine n'a pas de parent sur lequel s'arrêter, un merge ne se découpe pas en morceaux de diff.
    if (parents.length !== 1) throw new BranchBraceError('split-unsupported');
    try { await runGit(this.repositoryPath, ['merge-base', '--is-ancestor', hash, 'HEAD']); }
    catch { throw new BranchBraceError('split-not-on-branch'); }
    // Le rebase aplatirait les merges qui suivent le commit : on refuse plutôt que de réécrire plus que demandé.
    if (Number((await runGit(this.repositoryPath, ['rev-list', '--merges', '--count', `${parents[0]}..HEAD`])).trim())) throw new BranchBraceError('split-unsupported');
    const { commits } = await this.interactiveRebaseCommits(parents[0]);
    return this.interactiveRebase(parents[0], commits.map((commit) => ({ hash: commit.hash, action: commit.hash === hash ? 'split' : 'pick' })));
  }

  // Commit en cours de découpage : rebase arrêté (« edit ») sur un commit que le plan marque « split ».
  // `ready` : ce commit a déjà été retiré, ses changements attendent dans l'arbre de travail.
  async #splitState() {
    const planPath = await this.#rebasePlanPath();
    if (!existsSync(planPath)) return null;
    const directory = path.join(await this.#gitDirectory(), 'rebase-merge');
    const [plan, done, amend] = await Promise.all([
      readFile(planPath, 'utf8').then(JSON.parse).catch(() => []),
      readFile(path.join(directory, 'done'), 'utf8').catch(() => ''),
      readFile(path.join(directory, 'amend'), 'utf8').catch(() => null),
    ]);
    // Dernière ligne de `done` : l'étape sur laquelle le rebase est arrêté.
    const current = /^(?:edit|e)\s+([0-9a-f]+)/.exec(done.trim().split('\n').at(-1)?.trim() || '');
    const item = current && plan.find((step) => step.action === 'split' && step.hash.startsWith(current[1]));
    if (!item || amend === null) return null;
    const head = await runGit(this.repositoryPath, ['rev-parse', 'HEAD']).then((value) => value.trim(), () => null);
    const record = await runGit(this.repositoryPath, ['show', '-s', '--format=%h%x00%B', item.hash]);
    const [shortHash, ...message] = record.split('\0');
    return { hash: item.hash, shortHash, message: message.join('\0').trimEnd(), ready: head !== amend.trim() };
  }

  async #prepareSplitStop() {
    if (await this.operation() !== 'rebase') return;
    const split = await this.#splitState();
    if (split && !split.ready) await runGit(this.repositoryPath, ['reset', '--quiet', 'HEAD~1']);
  }

  // Ce qu'un merge de `source` ferait entrer dans la branche courante : ses commits absents de HEAD (les 200 plus
  // récents, et leur nombre total) et si un fast-forward suffirait (HEAD est alors un ancêtre de la source).
  async mergePreview(source) {
    await this.#ensureRepositoryPath();
    const target = await this.#resolveCommit(source);
    const [raw, total, branch, fastForward] = await Promise.all([
      runGit(this.repositoryPath, ['log', '-n', '200', '--format=%H%x00%h%x00%an%x00%at%x00%s%x1e', `HEAD..${target}`]),
      runGit(this.repositoryPath, ['rev-list', '--count', `HEAD..${target}`]),
      runGit(this.repositoryPath, ['branch', '--show-current']),
      runGit(this.repositoryPath, ['merge-base', '--is-ancestor', 'HEAD', target]).then(() => true, () => false),
    ]);
    const commits = raw.split('\x1e').map((record) => record.replace(/^\n/, '')).filter(Boolean).map((record) => {
      const [hash, shortHash, author, timestamp, ...subject] = record.split('\0');
      return { hash, shortHash, author, timestamp: Number(timestamp), subject: subject.join('\0') };
    });
    return { source, target, branch: branch.trim() || null, commits, total: Number(total.trim()), fastForward };
  }

  // Merge local de `source` dans la branche courante, après un point de reprise. Commit de merge par défaut (--no-ff) ;
  // `fastForward` laisse Git avancer la branche sans commit quand c'est possible. Jamais de squash. `expectedTarget`
  // est le commit prévisualisé : si la source a bougé depuis, rien n'est fusionné.
  async merge(source, { fastForward = false, expectedTarget = null } = {}) {
    const preview = await this.mergePreview(source);
    if (expectedTarget && preview.target !== expectedTarget) throw new BranchBraceError('merge-source-changed');
    if (!preview.branch) throw new BranchBraceError('detached-head');
    if (!preview.total) throw new BranchBraceError('nothing-to-merge');
    await this.#assertClean();
    // Même message que Git (« Merge branch 'x' into main »), mais calculé ici : Git ne voit que le SHA prévisualisé.
    // `source` est déjà validé par #resolveCommit (pas d'option) ; --end-of-options serait recopié tel quel par ce mode.
    const fullName = await runGit(this.repositoryPath, ['rev-parse', '--symbolic-full-name', source]).then((name) => name.trim(), () => '');
    const kinds = { 'refs/heads/': 'branch', 'refs/remotes/': 'remote-tracking branch', 'refs/tags/': 'tag' };
    const kind = Object.entries(kinds).find(([prefix]) => fullName.startsWith(prefix))?.[1];
    const subject = kind ? `${kind} '${source}'` : `commit '${preview.target.slice(0, 7)}'`;
    const recoveryRef = await this.#saveRecoveryRef('merge');
    // --commit et --no-squash l'emportent sur un `branch.<nom>.mergeOptions` qui demanderait l'inverse.
    try { await runGit(this.repositoryPath, ['merge', fastForward ? '--ff' : '--no-ff', '--commit', '--no-squash', '--no-edit', '-m', `Merge ${subject} into ${preview.branch}`, preview.target]); }
    catch (error) {
      // Git annonce un conflit de merge sur la sortie standard : c'est le merge resté en cours qui le signale.
      const code = await this.operation() === 'merge' ? 'conflict' : error.code || 'git-operation-failed';
      throw new BranchBraceError(code, recoveryRef, 'merge');
    }
    const head = (await runGit(this.repositoryPath, ['rev-parse', 'HEAD'])).trim();
    return { recoveryRef, fastForwarded: head === preview.target, status: await this.status() };
  }

  // Pull explicite : fetch du dépôt distant de l'upstream, puis fast-forward seul. Si la branche a aussi des commits
  // absents de l'upstream (divergence), rien n'est intégré : l'écart revient pour proposer un merge ou un rebase.
  // Il attend tout fetch en cours (même verrou) : un fetch d'arrière-plan ne tourne jamais en même temps.
  pull(expectedUpstream) {
    return this.#exclusiveSync(() => this.#pullNow(expectedUpstream));
  }

  async #pullNow(expectedUpstream) {
    await this.#ensureRepositoryPath();
    if (await this.operation()) throw new BranchBraceError('operation-in-progress');
    const read = (args) => runGit(this.repositoryPath, args).then((text) => text.trim(), () => '');
    const branch = await read(['branch', '--show-current']);
    const [upstream, remote] = branch
      ? await Promise.all([read(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']), read(['config', '--get', `branch.${branch}.remote`])])
      : ['', ''];
    if (!upstream || !remote || !upstream.startsWith(`${remote}/`)) throw new BranchBraceError('upstream-missing');
    if (expectedUpstream && upstream !== expectedUpstream) throw new BranchBraceError('upstream-changed');
    await runGit(this.repositoryPath, ['fetch', '--prune', '--no-recurse-submodules', remote]);
    // Branche supprimée côté serveur : le fetch --prune vient d'en retirer la copie locale.
    const target = await read(['rev-parse', '--verify', '--quiet', '@{upstream}^{commit}']);
    if (!target) throw new BranchBraceError('upstream-missing');
    const [ahead, behind] = (await runGit(this.repositoryPath, ['rev-list', '--left-right', '--count', `HEAD...${target}`])).trim().split(/\s+/).map(Number);
    if (!behind || ahead) return { upstream, ahead, behind, pulled: false, diverged: Boolean(behind && ahead), recoveryRef: null };
    const recoveryRef = await this.#saveRecoveryRef('pull');
    try { await runGit(this.repositoryPath, ['merge', '--ff-only', '--no-squash', target]); }
    catch (error) { throw new BranchBraceError(error.code || 'git-operation-failed', recoveryRef); }
    // Succès annoncé seulement si la branche pointe bien sur le commit de l'upstream récupéré.
    if (await read(['rev-parse', 'HEAD']) !== target) throw new BranchBraceError('pull-verification-failed', recoveryRef);
    return { upstream, ahead, behind, pulled: true, diverged: false, recoveryRef };
  }

  async #rebasePlanPath() { return path.join(await this.#gitDirectory(), 'branchbrace-rebase-plan.json'); }

  #rebaseEditorCommand() {
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const editorPath = fileURLToPath(new URL('../scripts/apply-rebase-plan.mjs', import.meta.url));
    return `${sequenceEditorRuntimePrefix()}${quote(process.execPath)} ${quote(editorPath)}`;
  }

  // Éditeur de messages : celui du plan s'il en reste un (rebase interactif lancé ici), sinon le message proposé par Git.
  async #rebaseEditors() {
    const planPath = await this.#rebasePlanPath();
    if (!existsSync(planPath)) return { GIT_EDITOR: 'true' };
    return { GIT_EDITOR: this.#rebaseEditorCommand(), BRANCHBRACE_REBASE_PLAN: planPath, BRANCHBRACE_REBASE_DONE: path.join(await this.#gitDirectory(), 'rebase-merge', 'done') };
  }

  async #cleanupRebasePlan() {
    if (await this.operation() !== 'rebase') await rm(await this.#rebasePlanPath(), { force: true });
  }

  // Contenu d'un blob (`HEAD:chemin`, `:chemin` pour l'index, `:2:chemin` pour un côté de conflit) ; null s'il n'existe pas.
  async #blob(spec, encoding = 'utf8') {
    if (spec.includes('\0')) throw new BranchBraceError('invalid-path');
    return runGit(this.repositoryPath, ['cat-file', 'blob', spec], { encoding }).catch((error) => {
      if (error.code === 'git-output-too-large') throw error;
      return null;
    });
  }

  // Les deux côtés du diff relus en octets exacts (latin1) : index → fichier pour indexer, HEAD → index pour désindexer.
  // Le fichier de travail est lu tel que `git add` le verrait (filtres et conversion des fins de ligne appliqués).
  async #partialSides(filePath, entry, stage) {
    const [indexEntry, headEntry] = await Promise.all([
      this.#indexEntry(filePath),
      stage ? null : runGit(this.repositoryPath, ['ls-tree', '-z', 'HEAD', '--', filePath]).then((raw) => {
        const [info, name] = raw.split('\0')[0].split('\t');
        return name === filePath ? { mode: info.split(' ')[0] } : null;
      }, () => null),
    ]);
    const indexContent = indexEntry ? (indexEntry.sha === EMPTY_BLOB ? '' : await this.#blob(indexEntry.sha, 'latin1')) : null;
    if (!stage) {
      const left = headEntry ? await this.#blob(`HEAD:${filePath}`, 'latin1') : null;
      return { left, right: indexContent, displayedRight: indexContent, fileMode: indexEntry?.mode ?? headEntry?.mode };
    }
    if (entry.worktreeStatus === 'D') return { left: indexContent, right: null, displayedRight: null, fileMode: indexEntry?.mode };
    const absolute = await this.#workingPath(filePath);
    // lstat : un lien symbolique n'est pas un fichier texte à découper en lignes.
    const info = await lstat(absolute);
    if (!info.isFile() || info.size > MAX_EDITABLE) throw new BranchBraceError('partial-staging-unsupported');
    const raw = (await readFile(absolute)).toString('latin1');
    const sha = (await runGit(this.repositoryPath, ['hash-object', '-w', '--', filePath])).trim();
    const right = await this.#blob(sha, 'latin1');
    // Un filtre qui change autre chose que les fins de ligne (LFS, ident…) : les lignes affichées ne sont pas celles
    // que Git indexerait.
    if (right === null || splitLines(raw).texts.join('\n') !== splitLines(right).texts.join('\n')) throw new BranchBraceError('partial-staging-unsupported');
    const executable = process.platform !== 'win32' && (info.mode & 0o111) !== 0;
    return { left: indexContent, right, displayedRight: raw, fileMode: indexEntry?.mode ?? (executable ? '100755' : '100644') };
  }

  async #applyLines(filePath, request, mode) {
    const entry = await this.#statusEntry(filePath);
    if (entry.conflicted || entry.originalPath) throw new BranchBraceError('partial-staging-unsupported');
    if (typeof request?.original !== 'string' || typeof request?.modified !== 'string') throw new BranchBraceError('invalid-content');
    const stage = mode === 'stage';
    const { left, right, displayedRight, fileMode } = await this.#partialSides(filePath, entry, stage);
    if (isBinary(left) || isBinary(right) || (fileMode !== '100644' && fileMode !== '100755')) throw new BranchBraceError('partial-staging-unsupported');
    // Le diff affiché doit être exactement celui du disque : sinon les numéros de ligne choisis ne désignent plus rien.
    const decode = (text) => Buffer.from(text ?? '', 'latin1').toString('utf8');
    if (decode(left) !== request.original || decode(displayedRight) !== request.modified) throw new BranchBraceError('diff-outdated');
    let plan;
    try {
      plan = buildPartialPatch({ path: filePath, mode, left, right, changes: request.changes, selection: request.selection, fileMode });
    } catch (error) {
      if (error instanceof PartialStagingError) throw new BranchBraceError(error.code);
      throw error;
    }

    const gitDirectory = await this.#gitDirectory();
    const indexPath = path.resolve(this.repositoryPath, (await runGit(this.repositoryPath, ['rev-parse', '--git-path', 'index'])).trim());
    const before = await this.#stagedRecords();
    const backup = await readFile(indexPath).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    const patchPath = path.join(gitDirectory, `branchbrace-partial-${randomUUID()}.patch`);
    await writeFile(patchPath, Buffer.from(plan.patch, 'latin1'), { mode: 0o600 });
    try {
      // --whitespace=nowarn : une configuration apply.whitespace=fix ne doit pas retoucher les lignes choisies.
      // core.longpaths : sous Windows, le chemin du patch dans un dépôt profond dépasse vite 260 caractères.
      await runGit(this.repositoryPath, ['-c', 'core.longpaths=true', 'apply', '--cached', '--whitespace=nowarn', ...(stage ? [] : ['--reverse']), patchPath]);
    } catch {
      // `git apply` est atomique : en cas de refus, l'index n'a pas été touché.
      throw new BranchBraceError('partial-apply-failed');
    } finally {
      await rm(patchPath, { force: true });
    }
    if (await this.#indexMatches(filePath, before, { ...plan, fileMode })) return this.status();
    try {
      if (backup === null) await rm(indexPath, { force: true });
      else {
        const temporary = `${indexPath}.branchbrace-restore`;
        await writeFile(temporary, backup);
        await rename(temporary, indexPath);
      }
    } catch {
      throw new BranchBraceError('partial-restore-failed');
    }
    throw new BranchBraceError('partial-verification-failed');
  }

  async #indexEntry(filePath) {
    const raw = await runGit(this.repositoryPath, ['ls-files', '--stage', '-z', '--', `:(literal)${filePath}`]);
    for (const record of raw.split('\0')) {
      const [info, name] = record.split('\t');
      if (name === filePath) { const [mode, sha] = info.split(' '); return { mode, sha }; }
    }
    return null;
  }

  // Ce que `git diff --cached` rapporte pour chaque chemin (modes et objets avant/après, statut).
  async #stagedRecords() {
    const fields = (await runGit(this.repositoryPath, ['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff'])).split('\0');
    const records = new Map();
    for (let i = 0; i + 1 < fields.length; i += 2) records.set(fields[i + 1], fields[i].replace(/^\n/, ''));
    return records;
  }

  // Garde de fiabilité : seuls le chemin visé et son contenu attendu ont changé dans l'index.
  async #indexMatches(filePath, before, expected) {
    const after = await this.#stagedRecords();
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      if (key !== filePath && before.get(key) !== after.get(key)) return false;
    }
    const entry = await this.#indexEntry(filePath);
    if (!expected.exists) return entry === null;
    if (!entry || entry.mode !== expected.fileMode) return false;
    const content = entry.sha === EMPTY_BLOB ? '' : await this.#blob(entry.sha, 'latin1');
    return content === expected.content;
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
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0') || path.isAbsolute(filePath) || /^[a-z]:/i.test(filePath)) throw new BranchBraceError('invalid-path');
    const segments = filePath.split(/[\\/]/);
    if (segments.some((segment) => segment === '..') || segments[0].toLowerCase() === '.git') throw new BranchBraceError('invalid-path');
    const absolute = path.resolve(this.repositoryPath, filePath);
    const root = await realpath(this.repositoryPath);
    const real = await realpath(absolute).catch(async (error) => {
      if (!allowMissing || error.code !== 'ENOENT') throw new BranchBraceError('invalid-path');
      return path.join(await realpath(path.dirname(absolute)).catch(() => { throw new BranchBraceError('invalid-path'); }), path.basename(absolute));
    });
    if (!real.startsWith(root + path.sep)) throw new BranchBraceError('invalid-path');
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
    if (!operation) throw new BranchBraceError('no-operation');
    return operation;
  }

  // Seuls les fichiers que `git status` liste peuvent être indexés, désindexés ou comparés.
  async #statusEntry(filePath) {
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) throw new BranchBraceError('invalid-path');
    const entry = (await this.status()).files.find((file) => file.path === filePath);
    if (!entry) throw new BranchBraceError('file-not-in-status');
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
    if (status.files.length) throw new BranchBraceError('working-tree-not-clean');
  }

  // Vérifie que le dossier est toujours la racine du dépôt choisi. Le résultat est gardé quelques secondes : chaque
  // lancement de git coûte cher sous Windows et une rafale d'appels (instantané, staging) n'a besoin que d'une vérification.
  #verifiedUntil = 0;
  async #ensureRepositoryPath() {
    if (Date.now() < this.#verifiedUntil) return;
    const root = (await runGit(this.repositoryPath, ['rev-parse', '--show-toplevel'])).trim();
    if (path.resolve(root) !== this.repositoryPath) throw new BranchBraceError('repository-mismatch');
    this.#verifiedUntil = Date.now() + 3000;
  }

  async #resolveCommit(revision) {
    if (typeof revision !== 'string' || revision.length > 255 || revision.startsWith('-') || /[\s\0~^:?*\\[\\]\\]/.test(revision) || revision.includes('..')) throw new BranchBraceError('invalid-revision');
    if (/^[0-9a-f]{7,40}$/i.test(revision)) {
      return (await runGit(this.repositoryPath, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])).trim();
    }
    try {
      await runGit(this.repositoryPath, ['check-ref-format', '--branch', revision]);
      return (await runGit(this.repositoryPath, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])).trim();
    } catch {
      throw new BranchBraceError('invalid-revision');
    }
  }

  async #saveRecoveryRef(operation) {
    return (await this.#savePoint(operation, 'operation')).ref;
  }

  // Point de reprise (ADR 0006), enregistré avant une opération destructive ou une réécriture d'historique.
  // `worktree` y ajoute les modifications non commitées (index, fichiers suivis et non suivis, au format stash, sans
  // toucher à la pile de stash) ; `refs` liste les autres branches (refs/heads/…) ou tags (refs/tags/…) que
  // l'opération va déplacer ou supprimer. La branche de HEAD est toujours enregistrée.
  async saveRecoveryPoint(operation, { worktree = false, refs = [] } = {}) {
    await this.#ensureRepositoryPath();
    return this.#summary(await this.#savePoint(operation, 'operation', { worktree, refs }));
  }

  // Points de reprise de cette worktree, du plus récent au plus ancien.
  async recoveryPoints() {
    await this.#ensureRepositoryPath();
    return (await this.#points()).map((point) => this.#summary(point));
  }

  // Ce que feraient Undo et Redo, pour les proposer (ou non) dans l'interface.
  async undoState() {
    await this.#ensureRepositoryPath();
    const points = await this.#points();
    const undo = this.#undoTarget(points);
    const redo = this.#redoTarget(points);
    return { undo: undo && this.#summary(undo), redo: redo && this.#summary(redo) };
  }

  // Undo : restaure le dernier point de reprise. L'état courant devient lui-même un point, celui du Redo.
  async undo() {
    await this.#ensureRepositoryPath();
    const point = this.#undoTarget(await this.#points());
    if (!point) throw new BranchBraceError('nothing-to-undo');
    return this.#restore(point, 'undo');
  }

  // Redo : restaure l'état enregistré par le dernier Undo, tant qu'aucune nouvelle opération ne l'a remplacé.
  async redo() {
    await this.#ensureRepositoryPath();
    const point = this.#redoTarget(await this.#points());
    if (!point) throw new BranchBraceError('nothing-to-redo');
    return this.#restore(point, 'redo');
  }

  // Restaure un point de reprise désigné par son identifiant ; comme un Undo, il peut être refait par Redo.
  async restoreRecoveryPoint(id) {
    await this.#ensureRepositoryPath();
    const point = (await this.#points()).find((item) => item.id === id);
    if (!point) throw new BranchBraceError('recovery-point-not-found');
    return this.#restore(point, 'undo');
  }

  // `refs/branchbrace/recovery/<id>` garde le commit de HEAD (nom historique, cité dans les messages) ;
  // `recovery-state/<id>` pointe un commit interne : message = description JSON du point, arbre = index enregistré,
  // parents = commits à garder en vie (HEAD, refs enregistrées, modifications non commitées).
  async #savePoint(operation, kind, { worktree = false, refs = [] } = {}) {
    if (typeof operation !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(operation)) throw new BranchBraceError('invalid-operation');
    if (!Array.isArray(refs)) throw new BranchBraceError('invalid-recovery-ref');
    const head = (await runGit(this.repositoryPath, ['rev-parse', '--verify', 'HEAD'])).trim();
    const branch = await this.#symbolicHead();
    const recorded = branch ? { [branch]: head } : {};
    for (const name of refs) {
      if (typeof name !== 'string' || !/^refs\/(heads|tags)\/./.test(name)) throw new BranchBraceError('invalid-recovery-ref');
      await runGit(this.repositoryPath, ['check-ref-format', name]).catch(() => { throw new BranchBraceError('invalid-recovery-ref'); });
      recorded[name] = await this.#refValue(name);
    }
    // Index non enregistrable (entrées en conflit) : la restauration se contentera alors de déplacer HEAD.
    const index = (await runGit(this.repositoryPath, ['write-tree']).catch(() => '')).trim() || null;
    const snapshot = worktree ? await this.#snapshotWorktree(head) : null;
    const createdAt = lastRecoveryTime = Math.max(Date.now(), lastRecoveryTime + 1);
    const id = `${operation}-${createdAt}-${randomUUID().slice(0, 8)}`;
    const state = { version: 1, operation, kind, createdAt, gitDir: await this.#gitDirectory(), head, branch, index, refs: recorded, snapshot, consumed: false };
    const parents = [head, snapshot];
    let kept = 0;
    for (const value of new Set(Object.values(recorded).filter((item) => item && item !== head))) {
      // Un tag annoté n'est pas un commit : une ref dédiée le garde en vie.
      if ((await runGit(this.repositoryPath, ['cat-file', '-t', value])).trim() === 'commit') parents.push(value);
      else await runGit(this.repositoryPath, ['update-ref', `refs/branchbrace/recovery-objects/${id}-${kept++}`, value]);
    }
    const tree = index || `${head}^{tree}`;
    const meta = await this.#commitTree(tree, parents, JSON.stringify(state));
    const ref = `refs/branchbrace/recovery/${id}`;
    await runGit(this.repositoryPath, ['update-ref', ref, head]);
    await runGit(this.repositoryPath, ['update-ref', `${RECOVERY_STATE}/${id}`, meta]);
    return { ...state, id, ref, stateRef: `${RECOVERY_STATE}/${id}`, tree, parents: [...new Set(parents.filter(Boolean))], state };
  }

  // Modifications non commitées au format d'une entrée de stash (parents : HEAD, index, fichiers non suivis), créée
  // par `git stash create` et un index temporaire : la pile de stash, partagée entre worktrees, n'est pas touchée.
  async #snapshotWorktree(head) {
    const created = (await runGit(this.repositoryPath, ['stash', 'create', 'branchbrace: point de reprise'], { env: RECOVERY_IDENTITY })).trim();
    // Une entrée finissant par « / » est un dépôt imbriqué : ni enregistré ni supprimé (`git clean` le laisse aussi).
    const untracked = (await runGit(this.repositoryPath, ['ls-files', '-z', '--others', '--exclude-standard'])).split('\0').filter((item) => item && !item.endsWith('/'));
    if (!untracked.length) return created || null;
    const token = randomUUID();
    const indexFile = path.join(await this.#gitDirectory(), `branchbrace-${token}.index`);
    const listFile = path.join(await this.#gitDirectory(), `branchbrace-${token}.paths`);
    try {
      await writeFile(listFile, untracked.join('\0'));
      const env = { GIT_INDEX_FILE: indexFile };
      await runGit(this.repositoryPath, ['--literal-pathspecs', 'add', `--pathspec-from-file=${listFile}`, '--pathspec-file-nul'], { env });
      const untrackedTree = (await runGit(this.repositoryPath, ['write-tree'], { env })).trim();
      const untrackedCommit = await this.#commitTree(untrackedTree, [], 'untracked files');
      const indexCommit = created ? `${created}^2` : await this.#commitTree(`${head}^{tree}`, [head], 'index');
      return this.#commitTree(created ? `${created}^{tree}` : `${head}^{tree}`, [head, indexCommit, untrackedCommit], 'branchbrace: point de reprise');
    } finally {
      await rm(indexFile, { force: true });
      await rm(listFile, { force: true });
    }
  }

  async #commitTree(tree, parents, message) {
    const args = ['commit-tree', tree];
    for (const parent of new Set(parents.filter(Boolean))) args.push('-p', parent);
    args.push('-m', message);
    return (await runGit(this.repositoryPath, args, { env: RECOVERY_IDENTITY })).trim();
  }

  async #points() {
    const raw = await runGit(this.repositoryPath, ['for-each-ref', '--format=%(refname)%00%(tree)%00%(parent)%00%(contents:subject)', RECOVERY_STATE]);
    const gitDir = await this.#gitDirectory();
    const points = [];
    for (const line of raw.split('\n').filter(Boolean)) {
      const [stateRef, tree, parents, subject] = line.split('\0');
      let state;
      try { state = JSON.parse(subject); } catch { continue; }
      if (state?.version !== 1 || state.gitDir !== gitDir) continue;
      const id = stateRef.slice(RECOVERY_STATE.length + 1);
      points.push({ ...state, id, ref: `refs/branchbrace/recovery/${id}`, stateRef, tree, parents: parents.split(' ').filter(Boolean), state });
    }
    return points.sort((a, b) => b.createdAt - a.createdAt);
  }

  // Undo vise le dernier point non restauré, sauf ceux qu'un Undo a créés (ceux-là sont pour Redo).
  #undoTarget(points) {
    return points.find((point) => !point.consumed && point.kind !== 'undo') || null;
  }

  // Redo vise le dernier état enregistré par un Undo, tant qu'aucune opération n'a eu lieu depuis.
  #redoTarget(points) {
    const lastOperation = Math.max(0, ...points.filter((point) => point.kind === 'operation').map((point) => point.createdAt));
    return points.find((point) => !point.consumed && point.kind === 'undo' && point.createdAt > lastOperation) || null;
  }

  #summary(point) {
    const { id, ref, operation, kind, createdAt, head, branch, refs, snapshot, consumed } = point;
    return { id, ref, operation, kind, createdAt, head, branch, refs, worktree: Boolean(snapshot), consumed };
  }

  async #restore(point, counterKind) {
    if (await this.operation()) throw new BranchBraceError('operation-in-progress');
    const branch = await this.#symbolicHead();
    if (branch !== point.branch) throw new BranchBraceError('recovery-point-other-branch');
    const head = (await runGit(this.repositoryPath, ['rev-parse', '--verify', 'HEAD'])).trim();
    const others = Object.entries(point.refs).filter(([name]) => name !== point.branch);
    if (branch) await this.#assertNotPublished(branch, head, point.head);
    for (const [name, target] of others) await this.#assertNotPublished(name, await this.#refValue(name), target);
    // Sans modifications enregistrées, les modifications locales sont gardées : Git refuse d'avance (essai à blanc)
    // si l'une d'elles devait être écrasée.
    const currentIndex = point.snapshot || !point.index ? null : (await runGit(this.repositoryPath, ['write-tree'])).trim();
    if (currentIndex) {
      // Comme `git status` : un fichier réécrit à l'identique ne doit pas compter comme modifié.
      await runGit(this.repositoryPath, ['update-index', '-q', '--refresh'], { acceptExitCodes: [1] });
      await runGit(this.repositoryPath, ['read-tree', '-n', '-m', '-u', currentIndex, point.index]).catch(() => { throw new BranchBraceError('unsafe-working-tree'); });
    }
    // L'état courant, modifications non commitées comprises, devient un point de reprise avant d'être remplacé.
    const counter = await this.#savePoint(counterKind, counterKind, { worktree: true, refs: others.map(([name]) => name) });
    if (point.snapshot) {
      await runGit(this.repositoryPath, ['reset', '--hard', '--quiet', point.head]);
      // Pas de `git clean` : seuls les fichiers non suivis que le point va réécrire sont retirés (l'état remplacé les
      // a déjà enregistrés), les autres restent en place.
      const untracked = await this.#refValue(`${point.snapshot}^3`);
      if (untracked) {
        const paths = (await runGit(this.repositoryPath, ['ls-tree', '-r', '-z', '--name-only', untracked])).split('\0').filter(Boolean);
        for (const filePath of paths) await rm(path.join(this.repositoryPath, filePath), { force: true });
      }
      await runGit(this.repositoryPath, ['stash', 'apply', '--index', '--quiet', point.snapshot]);
    } else if (currentIndex) {
      await runGit(this.repositoryPath, ['read-tree', '-m', '-u', currentIndex, point.index]);
      await runGit(this.repositoryPath, ['reset', '--soft', '--quiet', point.head]);
    } else {
      await runGit(this.repositoryPath, ['reset', '--keep', '--quiet', point.head]);
    }
    for (const [name, target] of others) {
      if (target) await runGit(this.repositoryPath, ['update-ref', name, target]);
      else await runGit(this.repositoryPath, ['update-ref', '-d', name]);
    }
    const meta = await this.#commitTree(point.tree, point.parents, JSON.stringify({ ...point.state, consumed: true }));
    await runGit(this.repositoryPath, ['update-ref', point.stateRef, meta]);
    return { restored: this.#summary(point), recoveryPoint: this.#summary(counter), status: await this.status() };
  }

  // Undo et Redo restent locaux : déplacer une branche ne doit pas retirer un commit déjà présent sur son upstream.
  async #assertNotPublished(name, from, to) {
    if (!from || !to || !name.startsWith('refs/heads/')) return;
    const upstream = (await runGit(this.repositoryPath, ['for-each-ref', '--format=%(upstream)', name])).trim();
    const published = upstream && await this.#refValue(upstream);
    if (!published) return;
    const bases = (await runGit(this.repositoryPath, ['merge-base', '--all', from, published], { acceptExitCodes: [1] })).split(/\s+/).filter(Boolean);
    for (const base of bases) {
      const kept = await runGit(this.repositoryPath, ['merge-base', '--is-ancestor', base, to]).then(() => true, () => false);
      if (!kept) throw new BranchBraceError('recovery-would-rewrite-published');
    }
  }

  async #symbolicHead() {
    return (await runGit(this.repositoryPath, ['symbolic-ref', '--quiet', 'HEAD'], { acceptExitCodes: [1] })).trim() || null;
  }

  async #refValue(name) {
    return (await runGit(this.repositoryPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', name], { acceptExitCodes: [1] })).trim() || null;
  }

  // Nom complet `prefixe + nom` vérifié par `git check-ref-format` (sans --branch, qui accepterait « @{-1} »).
  async #checkRefName(prefix, name, code) {
    if (typeof name !== 'string' || !name || name.length > 255 || name !== name.trim() || name.startsWith('-') || name.includes('\0')) throw new BranchBraceError(code);
    await runGit(this.repositoryPath, ['check-ref-format', `${prefix}${name}`]).catch(() => { throw new BranchBraceError(code); });
  }

  async #refExists(ref) {
    return (await runGit(this.repositoryPath, ['rev-parse', '--verify', '--quiet', ref], { acceptExitCodes: [1] })).trim() !== '';
  }

  #validateBranchName(name) {
    if (typeof name !== 'string' || !name.trim() || name.startsWith('-') || name.includes('\0')) throw new BranchBraceError('invalid-branch-name');
    if (name !== name.trim()) throw new BranchBraceError('invalid-branch-name');
  }
}
