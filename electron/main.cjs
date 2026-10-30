const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { GitService, GitWorkbenchError } = require('../src/git.js');

let mainWindow;
let repository = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1450,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#101216',
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
      app.exit(ready ? 0 : 1);
    }
  });
  if (app.isPackaged) mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  else mainWindow.loadURL('http://127.0.0.1:5173');
}

function service() {
  if (!repository) throw new GitWorkbenchError('repository-not-open');
  return repository;
}

async function confirm(title, message) {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning', title, message,
    buttons: ['Annuler', 'Confirmer'], defaultId: 0, cancelId: 0, noLink: true,
  });
  return response === 1;
}

app.whenReady().then(() => {
  ipcMain.handle('repository:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length !== 1) return null;
    const candidate = new GitService(result.filePaths[0]);
    await candidate.verifyRepository();
    repository = candidate;
    return { root: repository.repositoryPath, status: await repository.status(), history: await repository.history() };
  });
  ipcMain.handle('repository:refresh', async () => ({ status: await service().status(), history: await service().history() }));
  ipcMain.handle('repository:diff', async (_event, { path: filePath, staged }) => service().diff(filePath, staged === true));
  ipcMain.handle('repository:stage', async (_event, { path: filePath }) => {
    if (!await confirm('Ajouter au prochain commit ?', `Le fichier entier « ${filePath} » sera ajouté à l’index Git (pas de staging par hunk). Les hooks configurés peuvent s’exécuter lors du commit.`)) return null;
    return service().stage(filePath);
  });
  ipcMain.handle('repository:unstage', async (_event, { path: filePath }) => {
    if (!await confirm('Retirer de l’index ?', `Le fichier « ${filePath} » sera retiré de l’index. Son contenu de travail ne sera pas supprimé.`)) return null;
    return service().unstage(filePath);
  });
  ipcMain.handle('repository:commit', async (_event, { message }) => {
    if (!await confirm('Créer le commit local ?', 'Seuls les changements déjà indexés seront commités. Les hooks de commit configurés par Git seront exécutés.')) return null;
    return service().commit(message);
  });
  ipcMain.handle('repository:push', async (_event, { upstream }) => {
    const state = await service().status();
    if (!state.upstream) throw new GitWorkbenchError('upstream-missing');
    if (upstream !== state.upstream) throw new GitWorkbenchError('upstream-changed');
    if (!await confirm('Envoyer les commits ?', `Git va pousser vers ${upstream}. Le credential helper ou SSH configuré sera utilisé. Aucun force-push ne sera effectué.`)) return null;
    return service().push(upstream);
  });
  ipcMain.handle('repository:branches', async () => service().branches());
  ipcMain.handle('repository:branch:create', async (_event, { name }) => {
    if (!await confirm('Créer et basculer de branche ?', `Créer « ${name} » à partir du HEAD actuel, puis basculer dessus.`)) return null;
    return service().createBranch(name);
  });
  ipcMain.handle('repository:branch:switch', async (_event, { name }) => {
    if (!await confirm('Changer de branche ?', `Demander à Git de basculer vers « ${name} ». Git refusera si cela risque d’écraser des changements locaux.`)) return null;
    return service().switchBranch(name);
  });
  ipcMain.handle('repository:cherry-pick', async (_event, { commit }) => {
    const preview = await service().previewCommit(commit);
    if (!await confirm('Appliquer un commit ?', `Cherry-pick ${preview.shortHash} — ${preview.subject}\n(hash complet : ${preview.hash})\n\nUn point de récupération local sera conservé; les hooks Git configurés peuvent s’exécuter.`)) return null;
    return service().cherryPick(commit);
  });
  ipcMain.handle('repository:rebase', async (_event, { upstream }) => {
    const { upstream: resolvedBase, commits } = await service().interactiveRebaseCommits(upstream);
    const rangeLines = commits.length
      ? commits.map((commit) => `${commit.shortHash} ${commit.subject}`).join('\n')
      : '(aucun commit local à rejouer sur cette base)';
    if (!await confirm('Réécrire la branche ?', `Rebase sur « ${upstream} » (base résolue : ${resolvedBase.slice(0, 12)}).\n\nCommits qui seront rejoués, dans l’ordre :\n${rangeLines}\n\nUn point de récupération local sera conservé. Cette action réécrit les commits locaux; Git peut laisser une opération en conflit à résoudre ou annuler explicitement.`)) return null;
    return service().rebase(upstream);
  });
  ipcMain.handle('repository:rebase-interactive:commits', async (_event, { upstream }) => service().interactiveRebaseCommits(upstream));
  ipcMain.handle('repository:rebase-interactive:run', async (_event, { upstream, plan }) => {
    const { upstream: resolvedBase, commits } = await service().interactiveRebaseCommits(upstream);
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
    return service().interactiveRebase(upstream, plan);
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
