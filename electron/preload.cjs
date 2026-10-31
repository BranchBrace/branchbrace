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
  fetch: (root) => call('repository:fetch', { root }),
  checkoutRemote: (root, name) => call('repository:branch:checkout-remote', { root, name }),
  versions: (root, path, staged) => call('repository:versions', { root, path, staged }),
  commitVersions: (root, hash, path) => call('repository:commit:versions', { root, hash, path }),
  listFiles: (root) => call('repository:files', { root }),
  readFile: (root, path) => call('repository:file:read', { root, path }),
  writeFile: (root, path, content) => call('repository:file:write', { root, path, content }),
  conflictVersions: (root, path) => call('repository:conflict:versions', { root, path }),
  resolveConflict: (root, path, content) => call('repository:conflict:resolve', { root, path, content }),
  continueOperation: (root) => call('repository:operation:continue', { root }),
  skipOperation: (root) => call('repository:operation:skip', { root }),
  abortOperation: (root) => call('repository:operation:abort', { root }),
  headMessage: (root) => call('repository:head-message', { root }),
  amend: (root, message) => call('repository:amend', { root, message }),
  openFolder: (root) => call('shell:open-folder', { root }),
  showFile: (root, path) => call('shell:show-file', { root, path }),
  openTerminal: (root) => call('shell:open-terminal', { root }),
  openRemote: (root, remote, branch = null) => call('shell:open-remote', { root, remote, branch }),
}));
