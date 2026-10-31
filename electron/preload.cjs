const { contextBridge, ipcRenderer } = require('electron');

// Plusieurs dépôts peuvent être ouverts (onglets) : chaque appel désigne son dépôt par `root`, le chemin renvoyé
// par le processus principal. Celui-ci n'accepte que des dépôts ouverts via le sélecteur ou la session restaurée.
// Un refus Git attendu arrive comme valeur { workbenchError } : on le relance ici en erreur dont le message est un
// JSON { code, recoveryRef, operation }, seul champ qu'une Error conserve en traversant contextBridge.
const call = (channel, payload) => ipcRenderer.invoke(channel, payload).then((result) => {
  if (result && typeof result === 'object' && result.workbenchError) throw new Error(JSON.stringify(result.workbenchError));
  return result;
});

contextBridge.exposeInMainWorld('workbench', Object.freeze({
  // Le processus principal demande une confirmation ; la page l'affiche puis renvoie la réponse.
  onConfirmRequest: (handler) => ipcRenderer.on('confirm:request', (_event, request) => {
    Promise.resolve(handler({ title: request.title, message: request.message }))
      .then((accepted) => ipcRenderer.send('confirm:response', { id: request.id, accepted: accepted === true }))
      .catch(() => ipcRenderer.send('confirm:response', { id: request.id, accepted: false }));
  }),
  chooseRepository: () => call('repository:choose'),
  restoreSession: () => call('session:restore'),
  activate: (root) => call('session:activate', { root }),
  closeRepository: (root, next) => call('session:close', { root, next }),
  refresh: (root) => call('repository:refresh', { root }),
  commitDetails: (root, hash) => call('repository:commit:details', { root, hash }),
  commitFileDiff: (root, hash, path) => call('repository:commit:file-diff', { root, hash, path }),
  diff: (root, path, staged) => call('repository:diff', { root, path, staged }),
  stage: (root, path) => call('repository:stage', { root, path }),
  unstage: (root, path) => call('repository:unstage', { root, path }),
  stageAll: (root) => call('repository:stage-all', { root }),
  unstageAll: (root) => call('repository:unstage-all', { root }),
  commit: (root, message) => call('repository:commit', { root, message }),
  push: (root, upstream) => call('repository:push', { root, upstream }),
  branches: (root) => call('repository:branches', { root }),
  createBranch: (root, name, startPoint = null) => call('repository:branch:create', { root, name, startPoint }),
  switchBranch: (root, name) => call('repository:branch:switch', { root, name }),
  cherryPick: (root, commit) => call('repository:cherry-pick', { root, commit }),
  rebase: (root, upstream) => call('repository:rebase', { root, upstream }),
  interactiveRebaseCommits: (root, upstream) => call('repository:rebase-interactive:commits', { root, upstream }),
  interactiveRebase: (root, upstream, plan) => call('repository:rebase-interactive:run', { root, upstream, plan }),
}));
