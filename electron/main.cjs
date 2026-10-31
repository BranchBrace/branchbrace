const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { GitService, GitWorkbenchError } = require('../src/git.js');

let mainWindow;
const repositories = new Map();
const sessionFile = () => path.join(app.getPath('userData'), 'session.json');

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
  handle('repository:commit:details', async (_event, { root, hash }) => service(root).commitDetails(hash));
  handle('repository:commit:file-diff', async (_event, { root, hash, path: filePath }) => service(root).commitFileDiff(hash, filePath));
  handle('repository:diff', async (_event, { root, path: filePath, staged }) => service(root).diff(filePath, staged === true));
  // Actions locales réversibles (index, commit, branches, cherry-pick avec point de récupération) : sans confirmation.
  // Seuls le push (transmission hors de la machine) et les rebases (réécriture de l'historique) en demandent une.
  handle('repository:stage', async (_event, { root, path: filePath }) => service(root).stage(filePath));
  handle('repository:unstage', async (_event, { root, path: filePath }) => service(root).unstage(filePath));
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
  // Git refuse lui-même de basculer si cela risque d'écraser des changements locaux.
  handle('repository:branch:switch', async (_event, { root, name }) => service(root).switchBranch(name));
  handle('repository:cherry-pick', async (_event, { root, commit }) => service(root).cherryPick(commit));
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
    const { upstream: resolvedBase, commits } = await service(root).interactiveRebaseCommits(upstream);
    const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
    const planLines = Array.isArray(plan)
      ? plan.map((item, index) => {
          const commit = byHash.get(item?.hash);
          const shortHash = commit?.shortHash || (typeof item?.hash === 'string' ? item.hash.slice(0, 12) : '?');
          const subject = commit?.subject || '(commit inconnu)';
          return `${index + 1}. ${item?.action || '?'} ${shortHash} ${subject}`;
        }).join('\n')
      : '(plan invalide)';
    if (!await confirm('Confirmer le rebase interactif ?', `Base résolue : ${resolvedBase.slice(0, 12)}.\n\nPlan exact qui sera appliqué, dans l’ordre :\n${planLines}\n\nUne référence de récupération sera créée. En cas de conflit, l’opération reste à terminer ou annuler avec Git.`)) return null;
    return service(root).interactiveRebase(upstream, plan);
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  for (const resolve of pendingConfirms.values()) resolve(false);
  pendingConfirms.clear();
  if (process.platform !== 'darwin') app.quit();
});
