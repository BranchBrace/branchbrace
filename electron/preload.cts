import type { IpcRendererEvent } from 'electron';
import type { GrammarFile, ImportedExtension } from '../src/extensions.ts';
import type { GitService } from '../src/git.ts';
import type { GrammarCatalog } from '../src/grammar-catalog.ts';
import type { SyncSettings } from '../src/sync-settings.ts';
import type { DownloadProgress, UpdateChannel, UpdateCheck, UpdateSettings } from '../src/updates.ts';

// Preload en bac à sable : seul 'electron' peut être chargé ; les autres modules ne servent qu'aux types.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

// Valeur résolue (et argument) d'une méthode du service Git, telle que la page la reçoit par IPC.
type Git<K extends keyof GitService> = GitService[K] extends (...args: never[]) => infer R ? Awaited<R> : never;
type GitArg<K extends keyof GitService, I extends number> = GitService[K] extends (...args: infer A) => unknown ? A[I] : never;

export type Snapshot = Git<'snapshot'> & { root: string };
export interface SessionState {
  tabs: string[];
  active: string | null;
  snapshot: Snapshot | null;
}
export type WindowAction = 'zoom-in' | 'zoom-out' | 'zoom-reset' | 'fullscreen' | 'reload' | 'devtools' | 'quit';
export interface ConfirmRequest {
  title: string;
  message: string;
}
export type UpdateSettingsView = UpdateSettings & { current: string; installable: boolean };
export type UpdateInstallResult = { opened: string } | { installing: string };

// Plusieurs dépôts peuvent être ouverts (onglets) : chaque appel désigne son dépôt par `root`, le chemin renvoyé
// par le processus principal. Celui-ci n'accepte que des dépôts ouverts via le sélecteur ou la session restaurée.
// Un refus Git attendu arrive comme valeur { workbenchError } : on le relance ici en erreur dont le message est un
// JSON { code, recoveryRef, operation }, seul champ qu'une Error conserve en traversant contextBridge.
// `null` : action annulée par l'utilisateur (confirmation refusée, sélecteur fermé).
const call = <T,>(channel: string, payload?: unknown): Promise<T> => ipcRenderer.invoke(channel, payload).then((result: unknown) => {
  if (result && typeof result === 'object' && (result as { workbenchError?: unknown }).workbenchError) {
    throw new Error(JSON.stringify((result as { workbenchError: unknown }).workbenchError));
  }
  return result as T;
});

const api = Object.freeze({
  // Le processus principal demande une confirmation ; la page l'affiche puis renvoie la réponse.
  onConfirmRequest: (handler: (request: ConfirmRequest) => boolean | Promise<boolean>) => ipcRenderer.on('confirm:request', (_event: IpcRendererEvent, request: ConfirmRequest & { id: number }) => {
    Promise.resolve(handler({ title: request.title, message: request.message }))
      .then((accepted) => ipcRenderer.send('confirm:response', { id: request.id, accepted: accepted === true }))
      .catch(() => ipcRenderer.send('confirm:response', { id: request.id, accepted: false }));
  }),
  chooseRepository: () => call<Snapshot | null>('repository:choose'),
  windowAction: (action: WindowAction) => call<null>('window:action', { action }),
  restoreSession: () => call<SessionState>('session:restore'),
  activate: (root: string) => call<Snapshot>('session:activate', { root }),
  closeRepository: (root: string, next: string | null) => call<string[]>('session:close', { root, next }),
  refresh: (root: string) => call<Snapshot>('repository:refresh', { root }),
  commitDetails: (root: string, hash: string) => call<Git<'commitDetails'>>('repository:commit:details', { root, hash }),
  commitFileDiff: (root: string, hash: string, path: string) => call<Git<'commitFileDiff'>>('repository:commit:file-diff', { root, hash, path }),
  diff: (root: string, path: string, staged: boolean) => call<Git<'diff'>>('repository:diff', { root, path, staged }),
  stage: (root: string, path: string) => call<Git<'stage'>>('repository:stage', { root, path }),
  unstage: (root: string, path: string) => call<Git<'unstage'>>('repository:unstage', { root, path }),
  splitCommit: (root: string, hash: string) => call<Git<'splitCommit'> | null>('repository:split', { root, hash }),
  stageLines: (root: string, path: string, request: GitArg<'stageLines', 1>) => call<Git<'stageLines'>>('repository:stage-lines', { root, path, request }),
  unstageLines: (root: string, path: string, request: GitArg<'unstageLines', 1>) => call<Git<'unstageLines'>>('repository:unstage-lines', { root, path, request }),
  stageAll: (root: string) => call<Git<'stageAll'>>('repository:stage-all', { root }),
  unstageAll: (root: string) => call<Git<'unstageAll'>>('repository:unstage-all', { root }),
  commit: (root: string, message: string) => call<Git<'commit'>>('repository:commit', { root, message }),
  push: (root: string, upstream: string) => call<Git<'push'> | null>('repository:push', { root, upstream }),
  forcePush: (root: string, upstream: string) => call<Git<'forcePush'> | null>('repository:force-push', { root, upstream }),
  remotes: (root: string) => call<Git<'remotes'>>('repository:remotes', { root }),
  addRemote: (root: string, name: string, url: string) => call<Git<'addRemote'>>('repository:remote:add', { root, name, url }),
  renameRemote: (root: string, name: string, newName: string) => call<Git<'renameRemote'>>('repository:remote:rename', { root, name, newName }),
  setRemoteUrl: (root: string, name: string, url: string) => call<Git<'setRemoteUrl'>>('repository:remote:set-url', { root, name, url }),
  removeRemote: (root: string, name: string) => call<Git<'removeRemote'> | null>('repository:remote:remove', { root, name }),
  branches: (root: string) => call<Git<'branches'>>('repository:branches', { root }),
  createBranch: (root: string, name: string, startPoint: string | null = null) => call<Git<'createBranch'>>('repository:branch:create', { root, name, startPoint }),
  switchBranch: (root: string, name: string) => call<Git<'switchBranch'>>('repository:branch:switch', { root, name }),
  addWorktree: (root: string, branch: string, newBranch = false) => call<Git<'addWorktree'> | null>('repository:worktree:add', { root, branch, newBranch }),
  openWorktree: (root: string, path: string) => call<Snapshot>('repository:worktree:open', { root, path }),
  removeWorktree: (root: string, path: string) => call<{ worktrees: Git<'removeWorktree'>; tabs: string[] } | null>('repository:worktree:remove', { root, path }),
  pruneWorktrees: (root: string) => call<Git<'pruneWorktrees'> | null>('repository:worktree:prune', { root }),
  renameBranch: (root: string, name: string, newName: string, remote = false) => call<Git<'renameBranch'> | null>('repository:branch:rename', { root, name, newName, remote }),
  cherryPick: (root: string, commit: string) => call<Git<'cherryPick'>>('repository:cherry-pick', { root, commit }),
  revert: (root: string, commit: string, mainline: number | null = null) => call<Git<'revert'>>('repository:revert', { root, commit, mainline }),
  createTag: (root: string, name: string, commit: string, { annotated = true, message = '' }: { annotated?: boolean; message?: string } = {}) =>
    call<Git<'createTag'>>('repository:tag:create', { root, name, commit, annotated, message }),
  pushTag: (root: string, name: string, remote: string) => call<Git<'pushTag'> | null>('repository:tag:push', { root, name, remote }),
  rebase: (root: string, upstream: string) => call<Git<'rebase'> | null>('repository:rebase', { root, upstream }),
  interactiveRebaseCommits: (root: string, upstream: string) => call<Git<'interactiveRebaseCommits'>>('repository:rebase-interactive:commits', { root, upstream }),
  interactiveRebase: (root: string, upstream: string, plan: GitArg<'interactiveRebase', 1>) => call<Git<'interactiveRebase'>>('repository:rebase-interactive:run', { root, upstream, plan }),
  mergePreview: (root: string, source: string) => call<Git<'mergePreview'>>('repository:merge:preview', { root, source }),
  merge: (root: string, source: string, target: string, fastForward = false) => call<Git<'merge'>>('repository:merge', { root, source, target, fastForward }),
  pull: (root: string, upstream: string) => call<Git<'pull'>>('repository:pull', { root, upstream }),
  fetch: (root: string, background = false) => call<Snapshot & { skipped: Git<'fetch'>['skipped'] }>('repository:fetch', { root, background }),
  syncSettings: () => call<SyncSettings>('sync:settings'),
  setSyncSettings: (changes: Partial<SyncSettings>) => call<SyncSettings>('sync:settings:set', changes),
  checkoutRemote: (root: string, name: string) => call<Git<'checkoutRemote'>>('repository:branch:checkout-remote', { root, name }),
  versions: (root: string, path: string, staged: boolean) => call<Git<'workingVersions'>>('repository:versions', { root, path, staged }),
  commitVersions: (root: string, hash: string, path: string) => call<Git<'commitVersions'>>('repository:commit:versions', { root, hash, path }),
  listFiles: (root: string) => call<Git<'listFiles'>>('repository:files', { root }),
  readFile: (root: string, path: string) => call<Git<'readWorkingFile'>>('repository:file:read', { root, path }),
  writeFile: (root: string, path: string, content: string) => call<Git<'writeWorkingFile'>>('repository:file:write', { root, path, content }),
  conflictVersions: (root: string, path: string) => call<Git<'conflictVersions'>>('repository:conflict:versions', { root, path }),
  resolveConflict: (root: string, path: string, content: string | null) => call<Git<'resolveConflict'>>('repository:conflict:resolve', { root, path, content }),
  continueOperation: (root: string) => call<Git<'continueOperation'>>('repository:operation:continue', { root }),
  skipOperation: (root: string) => call<Git<'skipOperation'> | null>('repository:operation:skip', { root }),
  abortOperation: (root: string) => call<Git<'abortOperation'> | null>('repository:operation:abort', { root }),
  headMessage: (root: string) => call<Git<'headMessage'>>('repository:head-message', { root }),
  amend: (root: string, message: string) => call<Git<'amend'> | null>('repository:amend', { root, message }),
  undoState: (root: string) => call<Git<'undoState'>>('repository:undo-state', { root }),
  undo: (root: string) => call<Git<'undo'>>('repository:undo', { root }),
  redo: (root: string) => call<Git<'redo'>>('repository:redo', { root }),
  openFolder: (root: string) => call<boolean>('shell:open-folder', { root }),
  showFile: (root: string, path: string) => call<boolean>('shell:show-file', { root, path }),
  openTerminal: (root: string) => call<boolean>('shell:open-terminal', { root }),
  openRemote: (root: string, remote: string, branch: string | null = null) => call<boolean>('shell:open-remote', { root, remote, branch }),
  updateSettings: () => call<UpdateSettingsView>('updates:settings'),
  setUpdateSettings: (changes: Partial<UpdateSettings>) => call<UpdateSettings>('updates:settings:set', changes),
  checkForUpdate: (channel?: UpdateChannel) => call<UpdateCheck>('updates:check', { channel }),
  installUpdate: () => call<UpdateInstallResult | null>('updates:install'),
  onUpdateProgress: (handler: (progress: DownloadProgress) => void) => ipcRenderer.on('updates:progress', (_event: IpcRendererEvent, { received, total }: DownloadProgress) => handler({ received, total })),
  remoteIcon: (root: string, remote: string) => call<string | null>('shell:remote-icon', { root, remote }),
  grammarCatalog: () => call<GrammarCatalog>('grammars:catalog'),
  readGrammar: (scopeName: string) => call<GrammarFile>('grammars:read', { scopeName }),
  // Le Buffer lu par le processus principal arrive en Uint8Array.
  onigWasm: () => call<Uint8Array<ArrayBuffer>>('grammars:onig'),
  importExtension: () => call<{ imported: ImportedExtension; catalog: GrammarCatalog } | null>('extensions:import'),
  removeExtension: (id: string) => call<GrammarCatalog>('extensions:remove', { id }),
});

contextBridge.exposeInMainWorld('workbench', api);

export type WorkbenchApi = typeof api;
