const { app, BrowserWindow, Menu, dialog, ipcMain, net, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { GitService, GitWorkbenchError, samePath } = require('../src/git.js');
const updates = require('../src/updates.js');
const extensions = require('../src/extensions.js');
const syncSettings = require('../src/sync-settings.js');
const { fetchFavicon } = require('../src/favicon.js');

let mainWindow;
const repositories = new Map();
const favicons = new Map();
const sessionFile = () => path.join(app.getPath('userData'), 'session.json');
const updateSettingsFile = () => path.join(app.getPath('userData'), 'updates.json');
const syncSettingsFile = () => path.join(app.getPath('userData'), 'sync.json');
// Dernière release trouvée : l'installation ne porte que sur elle, jamais sur une URL reçue de la page.
let lastUpdateCheck = null;
let updateInProgress = false;
// Grammaires TextMate des extensions VS Code : inventaire fait une fois, refait après un import ou un retrait.
const importedExtensionsDir = () => path.join(app.getPath('userData'), 'vscode-extensions');
let grammarScan = null;
function scanGrammars(fresh = false) {
  if (fresh || !grammarScan) {
    grammarScan = extensions.extensionRoots({ home: app.getPath('home'), imported: importedExtensionsDir() }).then(extensions.scanExtensions);
    grammarScan.catch(() => { grammarScan = null; });
  }
  return grammarScan;
}

// Onglets ouverts et onglet actif, rouverts au lancement suivant. Seuls des chemins de dépôts vérifiés y sont écrits.
function readSession() {
  try {
    const data = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
    return { tabs: Array.isArray(data.tabs) ? data.tabs.filter((item) => typeof item === 'string') : [], active: typeof data.active === 'string' ? data.active : null };
  } catch { return { tabs: [], active: null }; }
}

function writeSession(active) {
  const tabs = [...repositories.keys()];
  fs.writeFileSync(sessionFile(), JSON.stringify({ tabs, active: tabs.includes(active) ? active : tabs[0] ?? null }, null, 2));
}

async function snapshot(root) {
  return { root, ...(await service(root).snapshot()) };
}

// Les refus attendus (arbre non propre, conflit, push rejeté…) reviennent à la page comme une valeur, pas comme une
// exception : Electron journaliserait sinon chaque refus comme une erreur. Les autres exceptions restent des bugs.
function handle(channel, handler) {
  ipcMain.handle(channel, async (...args) => {
    try { return await handler(...args); }
    catch (error) {
      if (!(error instanceof GitWorkbenchError)) throw error;
      return { workbenchError: { code: error.code, recoveryRef: error.recoveryRef, operation: error.operation } };
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1450,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#070c1d',
    title: 'Git Workbench',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const packagedEntry = pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
    const allowed = app.isPackaged ? url === packagedEntry : url.startsWith('http://127.0.0.1:5173/');
    if (!allowed) event.preventDefault();
  });
  mainWindow.webContents.once('did-finish-load', async () => {
    if (process.env.GIT_WORKBENCH_SMOKE === '1') {
      const ready = await mainWindow.webContents.executeJavaScript("document.title === 'Git Workbench' && Boolean(window.workbench)");
      console.log(ready ? 'Desktop window and isolated preload loaded.' : 'Desktop smoke check failed.');
      if (!ready || !process.env.GIT_WORKBENCH_SMOKE_REPO) return app.exit(ready ? 0 : 1);
      try {
        const candidate = new GitService(process.env.GIT_WORKBENCH_SMOKE_REPO);
        await candidate.verifyRepository();
        repositories.set(candidate.repositoryPath, candidate);
        const summary = await mainWindow.webContents.executeJavaScript(
          `window.workbench.refresh(${JSON.stringify(candidate.repositoryPath)}).then((r) => ({ branch: r.status.branch, files: r.status.files.length, commits: r.graph.commits.length, subject: r.graph.commits[0]?.subject }))`,
        );
        console.log(`Repository read through preload IPC: ${JSON.stringify(summary)}`);
        if (summary.commits === 0) return app.exit(1);
        if (process.env.GIT_WORKBENCH_SMOKE_REWRITE === '1') {
          // Disposable repositories only: exercises the packaged GIT_SEQUENCE_EDITOR path (pick newest, drop the other).
          const before = await candidate.history();
          const base = before[2].hash;
          const { commits } = await candidate.interactiveRebaseCommits(base);
          const [older, newer] = commits;
          await candidate.interactiveRebase(base, [{ hash: newer.hash, action: 'pick' }, { hash: older.hash, action: 'drop' }]);
          const after = await candidate.history();
          const applied = after.length === before.length - 1 && after[0].subject === newer.subject;
          console.log(applied ? `Packaged interactive rebase applied: ${after.map((commit) => commit.subject).join(' < ')}` : 'Packaged interactive rebase not applied.');
          return app.exit(applied ? 0 : 1);
        }
        app.exit(0);
      } catch (error) {
        console.log(`Repository smoke check failed: ${error?.code || error?.message || 'unknown'}`);
        app.exit(1);
      }
    }
  });
  if (app.isPackaged) mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  else mainWindow.loadURL('http://127.0.0.1:5173');
}

// Ouvre un terminal dans le dossier du dépôt. Le chemin passe par `cwd`, jamais par une ligne de commande à interpréter.
function openTerminal(cwd) {
  const attempts = process.platform === 'win32'
    ? [['wt.exe', ['-d', '.']], ['cmd.exe', ['/c', 'start', 'Git Workbench', 'cmd.exe']]]
    : process.platform === 'darwin'
      ? [['open', ['-a', 'Terminal', '.']]]
      : [['x-terminal-emulator', []], ['gnome-terminal', []], ['konsole', []], ['xterm', []]];
  return new Promise((resolve) => {
    const tryNext = (index) => {
      if (index >= attempts.length) return resolve(false);
      const [command, args] = attempts[index];
      const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', () => tryNext(index + 1));
      child.once('spawn', () => { child.unref(); resolve(true); });
    };
    tryNext(0);
  });
}

function service(root) {
  const repository = repositories.get(root);
  if (!repository) throw new GitWorkbenchError('repository-not-open');
  return repository;
}

// Confirmation affichée dans la page (aux couleurs de l'app), mais décidée ici : l'opération Git n'est lancée
// qu'après la réponse explicite de cette fenêtre à cette demande précise. Fenêtre fermée = annulation.
const pendingConfirms = new Map();
let confirmSequence = 0;
function confirm(title, message) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);
  const id = ++confirmSequence;
  return new Promise((resolve) => {
    pendingConfirms.set(id, resolve);
    mainWindow.webContents.send('confirm:request', { id, title, message });
  });
}
ipcMain.on('confirm:response', (event, { id, accepted }) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  const resolve = pendingConfirms.get(id);
  pendingConfirms.delete(id);
  resolve?.(accepted === true);
});

app.whenReady().then(() => {
  // Pas de barre de menu native (Windows, Linux) : le menu de l'application vit dans l'icône à gauche des onglets.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  handle('window:action', (_event, { action } = {}) => {
    const contents = mainWindow?.webContents;
    if (!contents) return null;
    if (action === 'zoom-in') contents.setZoomLevel(Math.min(contents.getZoomLevel() + 0.5, 4));
    else if (action === 'zoom-out') contents.setZoomLevel(Math.max(contents.getZoomLevel() - 0.5, -3));
    else if (action === 'zoom-reset') contents.setZoomLevel(0);
    else if (action === 'fullscreen') mainWindow.setFullScreen(!mainWindow.isFullScreen());
    else if (action === 'reload') contents.reload();
    else if (action === 'devtools' && !app.isPackaged) contents.toggleDevTools();
    else if (action === 'quit') app.quit();
    return null;
  });
  handle('repository:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length !== 1) return null;
    const candidate = new GitService(result.filePaths[0]);
    const root = await candidate.verifyRepository();
    if (!repositories.has(root)) repositories.set(root, candidate);
    writeSession(root);
    return snapshot(root);
  });
  handle('session:restore', async () => {
    if (process.env.GIT_WORKBENCH_SMOKE === '1') return { tabs: [], active: null, snapshot: null };
    const saved = readSession();
    for (const candidatePath of saved.tabs) {
      try {
        const candidate = new GitService(candidatePath);
        const root = await candidate.verifyRepository();
        if (!repositories.has(root)) repositories.set(root, candidate);
      } catch { /* dépôt déplacé ou supprimé depuis : on l'oublie */ }
    }
    const tabs = [...repositories.keys()];
    const active = tabs.includes(saved.active) ? saved.active : tabs[0] ?? null;
    writeSession(active);
    return { tabs, active, snapshot: active ? await snapshot(active) : null };
  });
  handle('session:activate', async (_event, { root }) => {
    const data = await snapshot(root);
    writeSession(root);
    return data;
  });
  handle('session:close', async (_event, { root, next }) => {
    repositories.delete(root);
    writeSession(next);
    return [...repositories.keys()];
  });
  handle('repository:refresh', async (_event, { root }) => snapshot(root));
  // Récupération explicite depuis les dépôts distants : met à jour les branches distantes affichées, rien d'autre.
  // `background` : fetch automatique, sans invite d'identifiants, sauté pendant une opération Git ou un autre fetch.
  handle('repository:fetch', async (_event, { root, background }) => {
    const { skipped } = await service(root).fetch({ background: background === true });
    return { skipped, ...(await snapshot(root)) };
  });
  handle('sync:settings', async () => syncSettings.readSyncSettings(syncSettingsFile()));
  handle('sync:settings:set', async (_event, changes) => syncSettings.writeSyncSettings(syncSettingsFile(), changes));
  handle('repository:branch:checkout-remote', async (_event, { root, name }) => service(root).checkoutRemote(name));
  handle('repository:versions', async (_event, { root, path: filePath, staged }) => service(root).workingVersions(filePath, staged === true));
  handle('repository:commit:versions', async (_event, { root, hash, path: filePath }) => service(root).commitVersions(hash, filePath));
  handle('repository:files', async (_event, { root }) => service(root).listFiles());
  handle('repository:file:read', async (_event, { root, path: filePath }) => service(root).readWorkingFile(filePath));
  handle('repository:file:write', async (_event, { root, path: filePath, content }) => service(root).writeWorkingFile(filePath, content));
  handle('repository:conflict:versions', async (_event, { root, path: filePath }) => service(root).conflictVersions(filePath));
  handle('repository:conflict:resolve', async (_event, { root, path: filePath, content }) => service(root).resolveConflict(filePath, content));
  handle('repository:operation:continue', async (_event, { root }) => service(root).continueOperation());
  handle('repository:operation:skip', async (_event, { root }) => {
    const operation = await service(root).operation();
    if (!await confirm('Passer ce commit ?', `Le commit en cours de ${operation === 'rebase' ? 'rebase' : operation} sera ignoré : ses changements ne seront pas appliqués. Les conflits déjà résolus pour lui sont abandonnés.`)) return null;
    return service(root).skipOperation();
  });
  handle('repository:operation:abort', async (_event, { root }) => {
    const operation = await service(root).operation();
    if (!await confirm('Annuler l’opération ?', `Git va annuler le ${operation} en cours et revenir à l’état d’avant. Les résolutions de conflit déjà faites seront perdues.`)) return null;
    return service(root).abortOperation();
  });
  handle('repository:head-message', async (_event, { root }) => service(root).headMessage());
  // L'amend réécrit le dernier commit : confirmation seulement s'il est déjà publié (il faudrait alors forcer le push,
  // ce que l'application ne fait jamais).
  handle('repository:amend', async (_event, { root, message }) => {
    if (await service(root).headPublished() && !await confirm('Amender un commit déjà poussé ?', `Le dernier commit est déjà sur ${(await service(root).status()).upstream}. Après l’amend, la branche locale divergera de sa distante et un push normal sera refusé (l’application ne force jamais un push).

Un point de récupération local sera conservé.`)) return null;
    return service(root).amend(message);
  });
  // Raccourcis vers le dossier du dépôt pour tester et vérifier hors de l'application.
  handle('shell:open-folder', async (_event, { root }) => { service(root); const error = await shell.openPath(root); return error === ''; });
  handle('shell:show-file', async (_event, { root, path: filePath }) => {
    service(root);
    const absolute = path.resolve(root, filePath);
    if (!absolute.startsWith(root + path.sep)) throw new GitWorkbenchError('invalid-path');
    shell.showItemInFolder(absolute);
    return true;
  });
  handle('shell:open-terminal', async (_event, { root }) => { service(root); return openTerminal(root); });
  // Page web d'un dépôt distant ou d'une branche : l'URL est recalculée ici depuis la configuration Git, jamais reçue de la page.
  handle('shell:open-remote', async (_event, { root, remote, branch }) => {
    const target = (await service(root).references()).remotes.find((item) => item.name === remote);
    if (!target?.web) throw new GitWorkbenchError('remote-no-web');
    const suffix = typeof branch === 'string' && branch ? (target.provider === 'gitlab' ? '/-/tree/' : '/tree/') + branch.split('/').map(encodeURIComponent).join('/') : '';
    await shell.openExternal(target.web + suffix);
    return true;
  });
  // Favicon de l'hébergeur d'un dépôt distant : l'hôte vient de la configuration Git, une seule requête par hôte.
  handle('shell:remote-icon', async (_event, { root, remote }) => {
    const target = (await service(root).references()).remotes.find((item) => item.name === remote);
    if (!target?.host) return null;
    if (!favicons.has(target.host)) favicons.set(target.host, fetchFavicon(target.host, net.fetch));
    return favicons.get(target.host);
  });
  handle('repository:commit:details', async (_event, { root, hash }) => service(root).commitDetails(hash));
  handle('repository:commit:file-diff', async (_event, { root, hash, path: filePath }) => service(root).commitFileDiff(hash, filePath));
  handle('repository:diff', async (_event, { root, path: filePath, staged }) => service(root).diff(filePath, staged === true));
  // Actions locales réversibles (index, commit, branches, cherry-pick avec point de récupération) : sans confirmation.
  // Seuls le push (transmission hors de la machine) et les rebases (réécriture de l'historique) en demandent une.
  handle('repository:stage', async (_event, { root, path: filePath }) => service(root).stage(filePath));
  handle('repository:unstage', async (_event, { root, path: filePath }) => service(root).unstage(filePath));
  handle('repository:stage-lines', async (_event, { root, path: filePath, request }) => service(root).stageLines(filePath, request));
  handle('repository:unstage-lines', async (_event, { root, path: filePath, request }) => service(root).unstageLines(filePath, request));
  handle('repository:stage-all', async (_event, { root }) => service(root).stageAll());
  handle('repository:unstage-all', async (_event, { root }) => service(root).unstageAll());
  handle('repository:commit', async (_event, { root, message }) => service(root).commit(message));
  handle('repository:push', async (_event, { root, upstream }) => {
    const state = await service(root).status();
    if (!state.upstream) throw new GitWorkbenchError('upstream-missing');
    if (upstream !== state.upstream) throw new GitWorkbenchError('upstream-changed');
    if (!await confirm('Envoyer les commits ?', `Git va pousser vers ${upstream}. Le credential helper ou SSH configuré sera utilisé. Aucun force-push ne sera effectué.`)) return null;
    return service(root).push(upstream);
  });
  handle('repository:branches', async (_event, { root }) => service(root).branches());
  handle('repository:branch:create', async (_event, { root, name, startPoint }) => service(root).createBranch(name, startPoint || null));
  // Renommer en local se défait en renommant à nouveau : sans confirmation. Renommer aussi sur le dépôt distant
  // publie un nouveau nom et en supprime un : confirmation explicite, avec ce qui sera fait.
  handle('repository:branch:rename', async (_event, { root, name, newName, remote }) => {
    if (remote === true) {
      const branch = (await service(root).references()).local.find((item) => item.name === name);
      if (!branch?.upstream || branch.gone) throw new GitWorkbenchError('upstream-missing');
      if (!await confirm('Renommer aussi la branche distante ?', `« ${name} » deviendra « ${newName} » en local et sur le dépôt distant de ${branch.upstream} :

1. push de « ${newName} » (nouvelle branche distante, aucun force-push) puis vérification ;
2. « ${newName} » suivra cette nouvelle branche distante ;
3. suppression de ${branch.upstream} sur le serveur, seulement si elle pointe encore sur ${branch.hash.slice(0, 12)}.

Les autres clones et les demandes de fusion ouvertes sur l’ancien nom ne suivront pas automatiquement.`)) return null;
    }
    return service(root).renameBranch(name, newName, { remote: remote === true });
  });
  // Worktrees : le dossier d'une nouvelle worktree est choisi ici dans le dialogue natif, jamais reçu de la page. Un
  // dossier non vide reçoit un sous-dossier au nom de la branche.
  handle('repository:worktree:add', async (_event, { root, branch, newBranch }) => {
    service(root);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: `Dossier de la worktree « ${branch} »`,
      buttonLabel: 'Créer la worktree ici',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    if (result.canceled || result.filePaths.length !== 1) return null;
    let target = result.filePaths[0];
    if (fs.existsSync(target) && fs.readdirSync(target).length) target = path.join(target, String(branch).replace(/[\\/:*?"<>|\s]+/g, '-'));
    return service(root).addWorktree(target, { branch, newBranch: newBranch === true });
  });
  // Ouvre une worktree du dépôt dans un onglet : seules celles que Git liste pour ce dépôt sont acceptées.
  handle('repository:worktree:open', async (_event, { root, path: target }) => {
    const worktree = (await service(root).worktrees()).find((item) => typeof target === 'string' && samePath(item.path, target));
    if (!worktree || worktree.prunable || worktree.bare) throw new GitWorkbenchError('worktree-not-found');
    const opened = [...repositories.keys()].find((key) => samePath(key, worktree.path));
    if (opened) { writeSession(opened); return snapshot(opened); }
    const candidate = new GitService(worktree.path);
    const verified = await candidate.verifyRepository();
    repositories.set(verified, candidate);
    writeSession(verified);
    return snapshot(verified);
  });
  handle('repository:worktree:remove', async (_event, { root, path: target }) => {
    const worktree = (await service(root).worktrees()).find((item) => typeof target === 'string' && samePath(item.path, target));
    if (!worktree) throw new GitWorkbenchError('worktree-not-found');
    const kept = worktree.branch ? ` ; la branche « ${worktree.branch} » est conservée` : '';
    const confirmed = worktree.prunable
      ? await confirm('Oublier la worktree introuvable ?', `Le dossier ${worktree.path} est introuvable : Git va oublier cette seule worktree${kept}.

S’il est seulement sur un disque débranché ou un partage indisponible, rebranchez-le plutôt : une fois oubliée, la worktree n’est plus reconnue par le dépôt.`)
      : await confirm('Supprimer la worktree ?', `Le dossier ${worktree.path} sera supprimé${kept}.

Git refusera s’il contient des changements non commités ou des fichiers non suivis : rien ne sera perdu.`);
    if (!confirmed) return null;
    const worktrees = await service(root).removeWorktree(worktree.path);
    // Son onglet éventuel n'a plus de dépôt derrière lui.
    for (const key of [...repositories.keys()]) if (samePath(key, worktree.path)) repositories.delete(key);
    writeSession(root);
    return { worktrees, tabs: [...repositories.keys()] };
  });
  // `git worktree prune` oublie toutes les worktrees introuvables, y compris celles d'un disque momentanément débranché.
  handle('repository:worktree:prune', async (_event, { root }) => {
    const missing = (await service(root).worktrees()).filter((item) => item.prunable && !item.locked);
    if (missing.length && !await confirm('Oublier les worktrees introuvables ?', `Ces worktrees sont introuvables (dossier supprimé, déplacé ou sur un disque débranché) et ne peuvent pas être ouvertes :

${missing.map((item) => `• ${item.path}${item.branch ? ` (branche « ${item.branch} », conservée)` : ''}`).join('\n')}

Git va les oublier. Si l’une d’elles est seulement sur un disque débranché, rebranchez-le plutôt.`)) return null;
    return service(root).pruneWorktrees();
  });
  // Git refuse lui-même de basculer si cela risque d'écraser des changements locaux.
  handle('repository:branch:switch', async (_event, { root, name }) => service(root).switchBranch(name));
  handle('repository:cherry-pick', async (_event, { root, commit }) => service(root).cherryPick(commit));
  // Merge local : la page montre d'abord les commits entrants, puis le merge porte sur le commit prévisualisé
  // (`target`). Point de reprise enregistré avant : pas de seconde confirmation, comme le rebase interactif.
  handle('repository:merge:preview', async (_event, { root, source }) => service(root).mergePreview(source));
  handle('repository:merge', async (_event, { root, source, target, fastForward }) => {
    if (typeof target !== 'string' || !target) throw new GitWorkbenchError('merge-source-changed');
    return service(root).merge(source, { fastForward: fastForward === true, expectedTarget: target });
  });
  // Pull explicite vers l'upstream affiché : fetch puis fast-forward seul. Une divergence revient sans rien intégrer.
  handle('repository:pull', async (_event, { root, upstream }) => {
    if (typeof upstream !== 'string' || !upstream) throw new GitWorkbenchError('upstream-missing');
    return service(root).pull(upstream);
  });
  handle('repository:rebase', async (_event, { root, upstream }) => {
    await service(root).assertClean();
    const { upstream: resolvedBase, commits } = await service(root).interactiveRebaseCommits(upstream);
    const rangeLines = commits.length
      ? commits.map((commit) => `${commit.shortHash} ${commit.subject}`).join('\n')
      : '(aucun commit local à rejouer sur cette base)';
    if (!await confirm('Réécrire la branche ?', `Rebase sur « ${upstream} » (base résolue : ${resolvedBase.slice(0, 12)}).\n\nCommits qui seront rejoués, dans l’ordre :\n${rangeLines}\n\nUn point de récupération local sera conservé. Cette action réécrit les commits locaux; Git peut laisser une opération en conflit à résoudre ou annuler explicitement.`)) return null;
    return service(root).rebase(upstream);
  });
  // Arbre propre exigé dès la préparation du plan : inutile de le composer pour un rebase qui serait refusé.
  handle('repository:rebase-interactive:commits', async (_event, { root, upstream }) => {
    await service(root).assertClean();
    return service(root).interactiveRebaseCommits(upstream);
  });
  handle('repository:rebase-interactive:run', async (_event, { root, upstream, plan }) => {
    await service(root).assertClean();
    // Pas de seconde confirmation : le plan, action par action, vient d'être validé dans l'éditeur de rebase, et
    // une référence de récupération permet de revenir en arrière.
    return service(root).interactiveRebase(upstream, plan);
  });
  // Découpage : réécrit la branche à partir du commit choisi, d'où la confirmation et le point de récupération.
  handle('repository:split', async (_event, { root, hash }) => {
    const target = service(root);
    await target.assertClean();
    const commit = await target.previewCommit(hash);
    if (!await confirm('Découper ce commit ?', `« ${commit.subject} » (${commit.shortHash}) va être retiré de la branche et ses changements remis dans l’arbre de travail. Committez-les en plusieurs morceaux (par fichier, par bloc ou par ligne), puis « Continuer » rejoue les commits suivants.

Un point de récupération local sera conservé ; « Annuler » revient à l’état d’avant. Si ce commit est déjà poussé, la branche divergera de sa distante (l’application ne force jamais un push).`)) return null;
    return target.splitCommit(commit.hash);
  // Coloration par les grammaires TextMate : fichiers lus ici, sur le disque local uniquement. La page demande une grammaire
  // par sa portée ; l'import d'un .vsix passe par le sélecteur de fichiers, jamais par un chemin reçu de la page.
  handle('grammars:catalog', async () => (await scanGrammars()).catalog);
  handle('grammars:read', async (_event, { scopeName }) => extensions.readGrammar(await scanGrammars(), scopeName));
  handle('grammars:onig', async () => fs.promises.readFile(require.resolve('vscode-oniguruma/release/onig.wasm')));
  handle('extensions:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Extension VS Code', extensions: ['vsix'] }] });
    if (result.canceled || result.filePaths.length !== 1) return null;
    const imported = await extensions.importVsix(result.filePaths[0], importedExtensionsDir());
    return { imported, catalog: (await scanGrammars(true)).catalog };
  });
  handle('extensions:remove', async (_event, { id }) => {
    await extensions.removeImported(importedExtensionsDir(), id);
    return (await scanGrammars(true)).catalog;
  });
  // Mises à jour : réseau limité à l'API publique des releases GitHub, sur demande ou si la vérification au démarrage
  // a été activée. Sous Windows l'installateur est téléchargé, vérifié (SHA-256) puis lancé ; ailleurs, la page de la
  // release s'ouvre dans le navigateur.
  handle('updates:settings', async () => ({
    ...(await updates.readUpdateSettings(updateSettingsFile(), app.getVersion())),
    current: app.getVersion(),
    installable: process.platform === 'win32' && app.isPackaged,
  }));
  handle('updates:settings:set', async (_event, changes) => updates.writeUpdateSettings(updateSettingsFile(), app.getVersion(), changes));
  handle('updates:check', async (_event, { channel } = {}) => {
    const settings = await updates.readUpdateSettings(updateSettingsFile(), app.getVersion());
    lastUpdateCheck = await updates.checkForUpdate({ currentVersion: app.getVersion(), channel: channel ?? settings.channel, fetch: net.fetch });
    return lastUpdateCheck;
  });
  handle('updates:install', async () => {
    const latest = lastUpdateCheck?.available ? lastUpdateCheck.latest : null;
    if (!latest) throw new GitWorkbenchError('update-not-available');
    if (!latest.installer || !app.isPackaged) {
      await shell.openExternal(latest.page);
      return { opened: latest.page };
    }
    if (updateInProgress) throw new GitWorkbenchError('update-in-progress');
    if (!await confirm(`Installer la version ${latest.version} ?`, `L’installateur ${latest.installer.name} va être téléchargé depuis GitHub (${Math.round(latest.installer.size / 1048576)} Mo) et son empreinte SHA-256 vérifiée. Git Workbench se fermera ensuite pour laisser l’installateur remplacer la version ${app.getVersion()}.

Vos onglets seront rouverts au prochain lancement.`)) return null;
    updateInProgress = true;
    try {
      const file = await updates.downloadInstaller(latest.installer, path.join(app.getPath('temp'), 'git-workbench-update'), {
        fetch: net.fetch,
        onProgress: (progress) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updates:progress', progress); },
      });
      await new Promise((resolve, reject) => {
        const child = spawn(file, [], { detached: true, stdio: 'ignore' });
        child.once('error', () => reject(new GitWorkbenchError('update-launch-failed')));
        child.once('spawn', () => { child.unref(); resolve(); });
      });
    } finally { updateInProgress = false; }
    setTimeout(() => app.quit(), 300);
    return { installing: latest.version };
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  for (const resolve of pendingConfirms.values()) resolve(false);
  pendingConfirms.clear();
  if (process.platform !== 'darwin') app.quit();
});
