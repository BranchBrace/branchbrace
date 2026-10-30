const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workbench', Object.freeze({
  chooseRepository: () => ipcRenderer.invoke('repository:choose'),
  refresh: () => ipcRenderer.invoke('repository:refresh'),
  diff: (path, staged) => ipcRenderer.invoke('repository:diff', { path, staged }),
  stage: (path) => ipcRenderer.invoke('repository:stage', { path }),
  unstage: (path) => ipcRenderer.invoke('repository:unstage', { path }),
  commit: (message) => ipcRenderer.invoke('repository:commit', { message }),
  push: (upstream) => ipcRenderer.invoke('repository:push', { upstream }),
  branches: () => ipcRenderer.invoke('repository:branches'),
  createBranch: (name) => ipcRenderer.invoke('repository:branch:create', { name }),
  switchBranch: (name) => ipcRenderer.invoke('repository:branch:switch', { name }),
  cherryPick: (commit) => ipcRenderer.invoke('repository:cherry-pick', { commit }),
  rebase: (upstream) => ipcRenderer.invoke('repository:rebase', { upstream }),
  interactiveRebaseCommits: (upstream) => ipcRenderer.invoke('repository:rebase-interactive:commits', { upstream }),
  interactiveRebase: (upstream, plan) => ipcRenderer.invoke('repository:rebase-interactive:run', { upstream, plan }),
}));
