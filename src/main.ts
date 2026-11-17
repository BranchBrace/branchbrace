import { WIP, renderGraph } from './graph-view.ts';
import { renderCommitDetails, renderWorkingChanges } from './details-view.ts';
import { renderRefs } from './refs-view.ts';
import { alertDialog, askChoice, askRename, askTag, askText, askWorktree, confirmDialog, element, modal, showMenu } from './dialogs.ts';
import type { MenuEntry } from './dialogs.ts';
import { editRebasePlan } from './rebase-editor.ts';
import { chooseIntegration, confirmMerge } from './merge-dialog.ts';
import { composeConventional } from './conventional-dialog.ts';
import { knownScopes } from './conventional.ts';
import { describeCode, describeError, errorCode } from './errors.ts';
import { askRemote } from './remote-dialog.ts';
import { checkOnStartup, openUpdates } from './update-dialog.ts';
import { openExtensions } from './extensions-dialog.ts';
import type { SyncSettings } from './sync-settings.ts';
import type { UpdateCheck } from './updates.ts';
import type {
  CommitDetails, Graph, GraphCommit as Commit, LineStagingRequest, LocalBranchRef, References as Refs, Remote, RemoteBranchRef,
  RepositoryStatus as Status, StatusEntry as StatusFile, Worktree,
} from './git.ts';

type Api = Window['workbench'];
// Instantané d'un dépôt ouvert, tel que le processus principal le renvoie (avec sa racine).
type Snapshot = NonNullable<Awaited<ReturnType<Api['activate']>>>;
type RefKind = 'local' | 'remote' | 'tags';
// Ref visée par un menu : celle des références, ou seulement son nom quand le graphe n'en sait pas plus.
type RefTarget = Partial<LocalBranchRef & RemoteBranchRef> & { name: string };
type Draft = { summary: string; description: string };
type View = 'graph' | 'diff' | 'review' | 'editor' | 'conflict';
type MonacoViews = typeof import('./diff-panel.ts') & typeof import('./editor-view.ts') & typeof import('./conflict-view.ts') & typeof import('./commit-review.ts');
type EditorView = ReturnType<MonacoViews['createEditorView']>;
type DiffOptions = Parameters<MonacoViews['showDiff']>[2];

const SUMMARY_LIMIT = 72;
// Éléments fixes de index.html ; le type attendu se précise à l'appel : $<HTMLButtonElement>('#refresh').
const $ = <E extends HTMLElement = HTMLElement>(selector: string): E => document.querySelector<E>(selector)!;
const summaryInput = () => $<HTMLInputElement>('#commit-summary');
const descriptionInput = () => $<HTMLTextAreaElement>('#commit-description');
const amendToggle = () => $<HTMLInputElement>('#amend-toggle');

const repositoryName = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() || root;
// Monaco (plusieurs Mo) n'est chargé qu'à la première vue qui en a besoin : le graphe s'affiche sans l'attendre.
let monacoViews: MonacoViews | null = null;
let viewsLoading: Promise<MonacoViews> | null = null;
const views = () => (viewsLoading ??= Promise.all([import('./diff-panel.ts'), import('./editor-view.ts'), import('./conflict-view.ts'), import('./commit-review.ts')])
  .then(([diff, editor, conflict, review]) => (monacoViews = { ...diff, ...editor, ...conflict, ...review })));
const OPERATION_NAMES: Readonly<Record<string, string>> = { rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', merge: 'Merge', revert: 'Revert' };
// Opération enregistrée dans un point de reprise, telle qu'Undo l'annonce.
const RECOVERY_NAMES: Readonly<Record<string, string>> = { amend: 'amend', 'cherry-pick': 'cherry-pick', rebase: 'rebase', 'interactive-rebase': 'rebase interactif', merge: 'merge', pull: 'pull', redo: 'Redo' };
const operationLabel = (operation: string) => RECOVERY_NAMES[operation] || operation;

const ui = {
  opened: false,
  root: null as string | null,
  tabs: [] as string[],
  drafts: new Map<string, Draft>(),
  // Incrémentée à chaque état appliqué : une réponse lancée avant reste périmée et ne l'écrase pas.
  generation: 0,
  branch: '',
  upstream: null as string | null,
  files: [] as StatusFile[],
  selected: null as string | null,
  graph: { head: null, commits: [] } as Graph,
  refs: { local: [], remote: [], tags: [], remotes: [], worktrees: [] } as Refs,
  selectedCommit: WIP as string,
  details: null as CommitDetails | null,
  detailFile: null as string | null,
  view: 'graph' as View,
  operation: null as Status['operation'],
  split: null as Status['split'],
  amend: null as Draft | null,
  editor: null as EditorView | null,
  toastTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  pendingUpdate: null as UpdateCheck | null,
  // Racine du dépôt de l'onglet courant, pour les actions qui ne sont proposées qu'avec un dépôt ouvert.
  get repo(): string { return this.root!; },
  async invoke<T>(action: () => Promise<T>): Promise<T | null> {
    try { return await action(); }
    catch (error) { this.message(describeError(error), true); return null; }
  },
  // Commande lancée explicitement (menu, bouton) : un refus s'affiche dans une fenêtre, pas seulement dans la ligne de statut.
  async act<T>(action: () => Promise<T>): Promise<T | null> {
    try { return await action(); }
    catch (error) {
      const text = describeError(error);
      this.message(text);
      await alertDialog({ title: 'Opération refusée', message: text });
      return null;
    }
  },
  // Toast bref et non bloquant : le résultat d'une action se lit dans le graphe, le toast ne fait que le confirmer.
  message(text: string, error = false) {
    const toast = $('#status-message');
    toast.textContent = text;
    toast.classList.toggle('error', error);
    toast.classList.add('visible');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => toast.classList.remove('visible'), error ? 6000 : 3000);
  },
  // Affiche un dépôt (instantané renvoyé par le processus principal) dans son onglet, en gardant le brouillon de
  // commit de l'onglet quitté.
  open(data: Snapshot | null, message: string | null = null) {
    if (!data) return;
    if (this.root) this.drafts.set(this.root, { summary: summaryInput().value, description: descriptionInput().value });
    const draft = this.drafts.get(data.root) || { summary: '', description: '' };
    summaryInput().value = draft.summary;
    descriptionInput().value = draft.description;
    this.opened = true;
    this.root = data.root;
    if (!this.tabs.includes(data.root)) this.tabs.push(data.root);
    $('#repo-name').textContent = repositoryName(data.root);
    $('#open-repo').title = `${data.root}\nCliquer pour ouvrir un autre dépôt dans un nouvel onglet`;
    $('#empty-state').hidden = true;
    for (const id of ['#new-branch', '#refresh', '#fetch-button', '#folder-button', '#view-graph', '#view-editor']) $<HTMLButtonElement>(id).disabled = false;
    autoFetch.run(data.root, { reason: 'open' });
    this.selected = null;
    this.selectedCommit = WIP;
    this.details = null;
    this.setAmend(false);
    this.update(data.status, data.graph, data.refs);
    this.refreshUndo();
    if (this.view === 'editor') this.showEditor();
    else this.showGraph();
    this.renderTabs();
    $('#graph-rows').scrollTop = 0;
    if (message) this.message(message);
  },
  renderTabs() {
    $('#tabs').replaceChildren(...this.tabs.map((root) => {
      const tab = document.createElement('div');
      tab.className = `tab${root === this.root ? ' active' : ''}`;
      tab.title = root;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(root === this.root));
      const icon = document.createElement('span'); icon.className = 'tab-icon'; icon.textContent = '⑂';
      const name = document.createElement('span'); name.className = 'tab-name'; name.textContent = repositoryName(root);
      const close = document.createElement('button'); close.className = 'tab-close'; close.textContent = '×'; close.title = 'Fermer l’onglet (le dépôt n’est pas modifié)';
      close.addEventListener('click', (event) => { event.stopPropagation(); this.closeTab(root); });
      tab.append(icon, name, close);
      tab.addEventListener('click', () => this.activate(root));
      tab.addEventListener('auxclick', (event) => { if (event.button === 1) this.closeTab(root); });
      return tab;
    }));
  },
  async activate(root: string) {
    if (root === this.root) return;
    const data = await this.invoke(() => window.workbench.activate(root));
    if (data) this.open(data, `Onglet ${repositoryName(root)}.`);
  },
  async closeTab(root: string) {
    const index = this.tabs.indexOf(root);
    const remaining = this.tabs.filter((item) => item !== root);
    const next = root === this.root ? remaining[Math.min(index, remaining.length - 1)] ?? null : this.root;
    const tabs = await this.invoke(() => window.workbench.closeRepository(root, next));
    if (!tabs) return;
    this.tabs = tabs;
    this.drafts.delete(root);
    this.editor?.forget(root);
    if (root !== this.root) { this.renderTabs(); return; }
    this.root = null;
    if (next) { await this.activate(next); return; }
    this.reset();
  },
  // Plus aucun onglet : retour à l'écran d'accueil.
  reset() {
    this.opened = false;
    this.files = [];
    this.details = null;
    $('#repo-name').textContent = 'Aucun dépôt';
    $('#branch-name').textContent = '—';
    for (const id of ['#new-branch', '#refresh', '#push-button', '#pull-button', '#fetch-button', '#folder-button', '#view-graph', '#view-editor', '#undo-button', '#redo-button']) $<HTMLButtonElement>(id).disabled = true;
    $('#sync-state').hidden = true;
    this.setView(null);
    $('#operation-banner').hidden = true;
    $('#empty-state').hidden = false;
    $('#ref-tree').replaceChildren();
    this.renderPanel();
    this.renderTabs();
  },
  async reload() {
    const result = await this.invoke(() => window.workbench.refresh(ui.repo));
    if (result) this.update(result.status, result.graph, result.refs);
    this.refreshUndo();
    return result;
  },
  // Undo/Redo (A17) : boutons actifs seulement s'il y a un point de reprise à restaurer ; l'infobulle dit lequel.
  async refreshUndo() {
    const root = this.root;
    const state = root ? await window.workbench.undoState(root).catch(() => null) : null;
    if (root !== this.root) return;
    $<HTMLButtonElement>('#undo-button').disabled = !state?.undo;
    $('#undo-button').title = state?.undo ? `Annuler : ${operationLabel(state.undo.operation)} (Ctrl+Z)` : 'Rien à annuler';
    $<HTMLButtonElement>('#redo-button').disabled = !state?.redo;
    $('#redo-button').title = state?.redo ? 'Rétablir l’état d’avant le dernier Undo (Ctrl+Maj+Z)' : 'Rien à rétablir';
  },
  async undo() {
    if (!this.opened || $<HTMLButtonElement>('#undo-button').disabled) return;
    const result = await this.act(() => window.workbench.undo(ui.repo));
    if (!result) return;
    await this.reload();
    this.message(`Undo : ${operationLabel(result.restored.operation)} annulé, retour à ${result.restored.head.slice(0, 7)}.`);
  },
  async redo() {
    if (!this.opened || $<HTMLButtonElement>('#redo-button').disabled) return;
    const result = await this.act(() => window.workbench.redo(ui.repo));
    if (!result) return;
    await this.reload();
    this.message(`Redo : état d’avant l’Undo rétabli (${result.restored.head.slice(0, 7)}).`);
  },
  update(status: Status, graph?: Graph | null, refs?: Refs | null) {
    this.generation += 1;
    this.files = status.files;
    this.branch = status.branch;
    this.upstream = status.upstream;
    this.operation = status.operation ?? null;
    this.split = status.split ?? null;
    if (graph) this.graph = graph;
    if (refs) this.refs = refs;
    $('#branch-name').textContent = status.branch;
    $<HTMLButtonElement>('#push-button').disabled = !status.upstream;
    $('#push-button').title = status.upstream ? `Pousser vers ${status.upstream}` : 'Upstream non configuré';
    $<HTMLButtonElement>('#pull-button').disabled = !status.upstream;
    $('#pull-button').title = status.upstream ? `Récupérer ${status.upstream} puis avancer la branche (fast-forward seul)` : 'Upstream non configuré';
    this.renderSyncState(status);
    if (this.selectedCommit !== WIP && !this.graph.commits.some((commit) => commit.hash === this.selectedCommit)) { this.selectedCommit = WIP; this.details = null; }
    this.renderGraph();
    this.renderRefs();
    this.renderPanel();
    this.renderBanner();
    this.editor?.updateStatus(this.files);
  },
  // Zone centrale : graphe, diff d'un fichier, éditeur ou résolution d'un conflit (null : écran d'accueil).
  setView(view: View | null, title = '') {
    if (this.view === 'diff' && view !== 'diff') monacoViews?.disposeDiff();
    if (this.view === 'conflict' && view !== 'conflict') monacoViews?.disposeConflict();
    if (this.view === 'review' && view !== 'review') monacoViews?.disposeReview();
    this.view = view ?? 'graph';
    $('#graph-panel').hidden = view !== 'graph';
    $('#diff-view').hidden = view !== 'diff';
    $('#review-view').hidden = view !== 'review';
    $('#editor-view').hidden = view !== 'editor';
    $('#conflict-view').hidden = view !== 'conflict';
    $('#workspace-header').hidden = view !== 'diff' && view !== 'conflict' && view !== 'review';
    $('#view-title').textContent = title;
    $('#view-graph').classList.toggle('active', view !== 'editor');
    $('#view-editor').classList.toggle('active', view === 'editor');
    if (view !== 'diff' && view !== 'conflict' && view !== 'review') $('#view-tools').replaceChildren();
  },
  async leaveDiff() {
    if (this.view === 'diff' && monacoViews?.diffIsDirty() && !await confirmDialog({ title: 'Quitter sans enregistrer ?', message: 'Le fichier modifié dans le diff n’a pas été enregistré (Ctrl+S). Ces modifications seront perdues.' })) return false;
    return true;
  },
  async showGraph() {
    if (!await this.leaveDiff()) return;
    this.setView('graph');
  },
  async showEditor(openPath: string | null = null) {
    if (!this.opened || !await this.leaveDiff()) return;
    const { createEditorView } = await views();
    this.editor ??= createEditorView($('#editor-view'), {
      api: window.workbench,
      message: (error, text) => this.message(error ? describeError(error) : text ?? ''),
      confirm: confirmDialog,
      onSaved: () => this.reload(),
      onShowDiff: (filePath) => this.showDiff(filePath),
    });
    this.setView('editor');
    await this.editor.show(this.repo, this.files);
    if (openPath) await this.editor.open(openPath);
  },
  // Bandeau d'une opération Git interrompue : nombre de conflits et actions pour la terminer.
  renderBanner() {
    const banner = $('#operation-banner');
    if (!this.opened || !this.operation) { banner.hidden = true; return; }
    const conflicts = this.files.filter((file) => file.conflicted);
    const name = OPERATION_NAMES[this.operation] || this.operation;
    const text = document.createElement('div');
    text.className = 'banner-text';
    const strong = document.createElement('strong'); strong.textContent = this.split ? `Découpage de ${this.split.shortHash}` : `${name} en cours`;
    const detail = document.createElement('span');
    const pending = this.files.length;
    detail.textContent = conflicts.length
      ? ` — ${conflicts.length} fichier${conflicts.length > 1 ? 's' : ''} en conflit à résoudre, puis Continuer.`
      : this.split
        ? (pending ? ` — ${pending} fichier${pending > 1 ? 's' : ''} à recommitter en morceaux (par fichier, par bloc ou par ligne), puis Continuer.` : ' — tout est recommité : Continuer rejoue la suite de la branche.')
        : ' — aucun conflit restant : vous pouvez continuer.';
    text.append(strong, detail);
    const button = (label: string, className: string, action: () => void, title: string) => {
      const node = document.createElement('button'); node.className = `button compact ${className}`; node.textContent = label; node.title = title;
      node.addEventListener('click', action);
      return node;
    };
    const actions: HTMLButtonElement[] = [];
    if (conflicts.length) actions.push(button('Résoudre le suivant', 'secondary', () => this.showConflict(conflicts[0].path), 'Ouvrir l’outil de fusion sur le premier fichier en conflit'));
    const split = this.split;
    if (split) actions.push(button('Message d’origine', 'secondary', () => this.fillCommitMessage(split.message), 'Reprendre le message du commit découpé dans la zone de commit'));
    actions.push(button('Continuer', 'primary', () => this.continueOperation(), `git ${this.operation} --continue`));
    if (this.operation !== 'merge' && !this.split) actions.push(button('Passer ce commit', 'secondary', () => this.skipOperation(), `git ${this.operation} --skip`));
    actions.push(button('Annuler l’opération', 'danger', () => this.abortOperation(), `git ${this.operation} --abort`));
    banner.replaceChildren(text, ...actions);
    banner.hidden = false;
  },
  async continueOperation() {
    const result = await this.act(() => window.workbench.continueOperation(ui.repo));
    await this.reload();
    if (result && this.split) this.message(`Commit ${this.split.shortHash} retiré à son tour : recommittez-le en morceaux, puis Continuer.`);
    else if (result) this.message(this.operation ? `${OPERATION_NAMES[result.operation]} : nouvelle étape, de nouveaux conflits sont peut-être à résoudre.` : `${OPERATION_NAMES[result.operation]} terminé.`);
  },
  async skipOperation() {
    const result = await this.act(() => window.workbench.skipOperation(ui.repo));
    if (result) { await this.reload(); this.message('Commit passé.'); }
  },
  async abortOperation() {
    const result = await this.act(() => window.workbench.abortOperation(ui.repo));
    if (result) { await this.reload(); if (this.view === 'conflict') this.setView('graph'); this.message(`${OPERATION_NAMES[result.operation]} annulé : retour à l’état d’avant.`); }
  },
  async showConflict(filePath: string) {
    if (!await this.leaveDiff()) return;
    const [data, { showConflict: renderConflict }] = await Promise.all([this.invoke(() => window.workbench.conflictVersions(ui.repo, filePath)), views()]);
    if (!data) return;
    this.selected = filePath;
    this.renderPanel();
    this.setView('conflict', `${filePath} · conflit`);
    renderConflict($('#conflict-view'), $('#view-tools'), {
      data,
      onClose: () => this.showGraph(),
      onResolve: async (content) => {
        const status = await this.act(() => window.workbench.resolveConflict(ui.repo, filePath, content));
        if (!status) return;
        this.update(status);
        this.editor?.reloadClean(filePath);
        const next = this.files.find((file) => file.conflicted);
        if (next) { this.message(`${filePath} résolu. Conflit suivant : ${next.path}.`); await this.showConflict(next.path); return; }
        this.setView('graph');
        this.message(`${filePath} résolu. Plus aucun conflit : cliquez sur Continuer pour terminer le ${(this.operation && OPERATION_NAMES[this.operation]) || 'travail'}.`);
      },
    });
  },
  renderGraph() {
    renderGraph($('#graph-rows'), { ...this.graph, wip: this.files.length, selected: this.selectedCommit, refs: this.refs }, {
      onSelect: (hash) => this.selectCommit(hash),
      onCheckout: (branch) => this.checkout(branch),
      onContextMenu: (commit, x, y) => this.commitMenu(commit, x, y),
      onRefMenu: (kind, name, x, y) => this.refMenu(kind, this.findRef(kind, name) || { name }, x, y),
    });
  },
  renderRefs() {
    renderRefs($('#ref-tree'), this.refs, {
      filter: $<HTMLInputElement>('#ref-filter').value,
      selectedHash: this.selectedCommit,
      onSelect: (hash) => this.revealCommit(hash),
      onActivate: (branch) => this.checkout(branch),
      onCheckoutRemote: (name) => this.checkoutRemote(name),
      onOpenRemote: (remote: string, branch?: string) => this.invoke(() => window.workbench.openRemote(ui.repo, remote, branch)),
      onRemoteMenu: (remote, x, y) => this.remoteMenu(remote, x, y),
      loadRemoteIcon: (remote) => window.workbench.remoteIcon(ui.repo, remote),
      onContextMenu: (kind, ref, x, y) => this.refMenu(kind, ref, x, y),
      onOpenWorktree: (folder) => this.openWorktree(folder),
      onWorktreeMenu: (worktree, x, y) => this.worktreeMenu(worktree, x, y),
    });
  },
  findRef<K extends RefKind>(kind: K, name: string): Refs[K][number] | undefined {
    const refs: readonly Refs[K][number][] | undefined = this.refs[kind];
    return refs?.find((ref) => ref.name === name);
  },
  async revealCommit(hash: string) {
    const row = document.querySelector(`.graph-row[data-hash="${hash}"]`);
    if (!row) { this.message('Ce commit est au-delà des 500 derniers affichés dans le graphe.'); return; }
    if (this.view !== 'graph') await this.showGraph();
    row.scrollIntoView({ block: 'center' });
    this.selectCommit(hash);
  },
  async selectCommit(hash: string) {
    this.selectedCommit = hash || WIP;
    this.details = null;
    this.detailFile = null;
    document.querySelectorAll<HTMLElement>('#graph-rows .graph-row').forEach((row) => row.classList.toggle('selected', row.dataset.hash === this.selectedCommit));
    if (this.selectedCommit !== WIP) {
      const details = await this.invoke(() => window.workbench.commitDetails(ui.repo, hash));
      if (!details || this.selectedCommit !== hash) return;
      this.details = details;
    }
    this.renderPanel();
    this.renderRefs();
    // La revue ouverte suit le commit sélectionné ; sans commit (WIP), retour au graphe.
    if (this.view === 'review' && monacoViews?.reviewedCommit() !== this.details?.hash) {
      if (this.details) await this.showCommitReview(this.details.hash);
      else this.setView('graph');
    }
  },
  // Droite : détail du commit sélectionné, sinon zone de staging + composition du commit (comme GitKraken).
  renderPanel() {
    const panel = $('#commit-details');
    const composer = $('#commit-composer');
    if (!this.opened) { panel.hidden = true; composer.hidden = true; return; }
    if (this.details) {
      const { hash } = this.details;
      composer.hidden = true;
      renderCommitDetails(panel, this.details, {
        selectedFile: this.detailFile,
        onClose: () => this.selectCommit(WIP),
        onReview: () => this.showCommitReview(hash),
        onOpenFile: (file) => this.showCommitReview(hash, file.path),
        onFileMenu: (file, x, y) => showMenu([
          ['Voir dans la revue du commit', () => this.showCommitReview(hash, file.path)],
          ['Voir ce fichier seul', () => this.showCommitDiff(hash, file.path)],
          ['Ouvrir la version de travail dans l’éditeur', () => this.showEditor(file.path), file.status === 'D'],
          ['Afficher dans le dossier', () => this.invoke(() => window.workbench.showFile(ui.repo, file.path)), file.status === 'D'],
          null,
          ['Copier le chemin', () => this.copy(file.path, 'Chemin copié')],
        ], x, y),
        onSelectParent: (parent) => this.revealCommit(parent),
      });
      return;
    }
    renderWorkingChanges(panel, this.files, {
      branch: this.branch,
      selectedFile: this.selected,
      onOpenFile: (file, staged) => (file.conflicted ? this.showConflict(file.path) : this.showDiff(file.path, staged)),
      onResolve: (file) => this.showConflict(file.path),
      onToggleStage: (file) => this.toggleStage(file),
      onStageAll: () => this.applyStatus(() => window.workbench.stageAll(ui.repo)),
      onUnstageAll: () => this.applyStatus(() => window.workbench.unstageAll(ui.repo)),
      onFileMenu: (file, staged, x, y) => showMenu(file.conflicted ? [
        ['Résoudre le conflit…', () => this.showConflict(file.path)],
        ['Ouvrir dans l’éditeur', () => this.showEditor(file.path)],
        null,
        ['Afficher dans le dossier', () => this.invoke(() => window.workbench.showFile(ui.repo, file.path))],
        ['Copier le chemin', () => this.copy(file.path, 'Chemin copié')],
      ] : [
        [staged ? 'Retirer de l’index' : 'Ajouter à l’index', () => this.toggleStage(file)],
        ['Voir le diff', () => this.showDiff(file.path, staged)],
        ['Ouvrir dans l’éditeur', () => this.showEditor(file.path), file.worktreeStatus === 'D'],
        null,
        ['Afficher dans le dossier', () => this.invoke(() => window.workbench.showFile(ui.repo, file.path)), file.worktreeStatus === 'D'],
        ['Copier le chemin', () => this.copy(file.path, 'Chemin copié')],
      ], x, y),
    });
    composer.hidden = false;
    this.updateComposer();
  },
  updateComposer() {
    const staged = this.files.filter((file) => file.staged).length;
    const summary = summaryInput().value;
    const remaining = SUMMARY_LIMIT - summary.length;
    $('#summary-count').textContent = String(remaining);
    $('#summary-count').classList.toggle('over', remaining < 0);
    const button = $<HTMLButtonElement>('#commit-button');
    const amending = Boolean(this.amend);
    $('#commit-composer').classList.toggle('amending', amending);
    $('#composer-label').textContent = amending ? 'Amender le dernier commit' : 'Commit';
    // Pas d'amend au milieu d'un rebase ou d'un cherry-pick : le dernier commit n'est pas encore celui de la branche.
    amendToggle().disabled = !this.graph.head || (Boolean(this.operation) && !amending);
    if (amending) {
      button.disabled = !summary.trim();
      button.textContent = !summary.trim() ? 'Saisissez un résumé' : staged ? `Amender avec ${staged} fichier${staged > 1 ? 's' : ''} indexé${staged > 1 ? 's' : ''}` : 'Amender le message';
      return;
    }
    button.disabled = !staged || !summary.trim();
    button.textContent = !staged ? 'Indexez des changements pour committer' : !summary.trim() ? 'Saisissez un résumé' : `Committer ${staged} fichier${staged > 1 ? 's' : ''}`;
  },
  // Amend : le message du dernier commit remplace le brouillon le temps de l'édition ; décocher rend le brouillon.
  async setAmend(enabled: boolean) {
    amendToggle().checked = enabled;
    if (enabled && !this.amend) {
      const message = await this.invoke(() => window.workbench.headMessage(ui.repo));
      if (message === null) { amendToggle().checked = false; return; }
      this.amend = { summary: summaryInput().value, description: descriptionInput().value };
      const [summary, ...body] = message.split('\n');
      summaryInput().value = summary;
      descriptionInput().value = body.join('\n').trim();
    } else if (!enabled && this.amend) {
      summaryInput().value = this.amend.summary;
      descriptionInput().value = this.amend.description;
      this.amend = null;
    }
    this.updateComposer();
  },
  async conventional() {
    const result = await composeConventional({
      summary: summaryInput().value,
      description: descriptionInput().value,
      scopes: knownScopes(this.graph.commits.map((commit) => commit.subject)),
    });
    if (!result) return;
    summaryInput().value = result.summary;
    descriptionInput().value = result.description;
    this.updateComposer();
    summaryInput().focus();
  },
  async applyStatus(action: () => Promise<Status>) {
    const status = await this.act(action);
    if (status) this.update(status);
    return status;
  },
  async toggleStage(file: StatusFile) {
    if (await this.applyStatus(() => file.staged ? window.workbench.unstage(ui.repo, file.path) : window.workbench.stage(ui.repo, file.path)) && this.selected === file.path && this.view === 'diff' && !monacoViews?.diffIsDirty()) {
      const updated = this.files.find((item) => item.path === file.path);
      if (updated) await this.showDiff(file.path, updated.staged && !updated.unstaged);
    }
  },
  async checkoutRemote(name: string) {
    const status = await this.act(() => window.workbench.checkoutRemote(ui.repo, name));
    if (status) { await this.reload(); this.message(`Branche locale « ${status.branch} » créée : elle suit ${name}.`); }
  },
  // ↑ commits locaux à pousser, ↓ commits distants à récupérer par Pull, d'après le dernier fetch.
  renderSyncState(status: Status) {
    const state = $('#sync-state');
    const { upstream, ahead = 0, behind = 0 } = status;
    state.hidden = !upstream;
    state.classList.toggle('diverged', ahead > 0 && behind > 0);
    const up = document.createElement('span'); up.textContent = `↑${ahead}`;
    const down = document.createElement('span'); down.textContent = `↓${behind}`;
    down.classList.toggle('behind', behind > 0);
    state.replaceChildren(up, ' ', down);
    state.title = !upstream ? '' : ahead && behind
      ? `Divergée de ${upstream} : ${ahead} commit(s) local(aux), ${behind} distant(s). Pull n’avancera pas la branche : il proposera un merge ou un rebase explicite.`
      : `${ahead} commit(s) à pousser, ${behind} à récupérer depuis ${upstream} (état du dernier fetch).`;
  },
  // Échec d'un fetch automatique : un point sur le bouton Fetch, le détail dans son info-bulle, pas de fenêtre.
  setSyncError(error: unknown) {
    const button = $('#fetch-button');
    button.classList.toggle('sync-error', Boolean(error));
    button.title = error
      ? `Dernier fetch automatique échoué : ${describeError(error)} Cliquer pour réessayer.`
      : 'Récupérer les branches des dépôts distants (git fetch --all --prune)';
  },
  // Le dépôt est capturé avant l'attente : si l'onglet a changé entre-temps, le résultat n'est pas affiché dans l'autre.
  async fetch() {
    const root = this.repo;
    $<HTMLButtonElement>('#fetch-button').disabled = true;
    this.message('Récupération depuis les dépôts distants…');
    const data = await this.act(() => window.workbench.fetch(root));
    $<HTMLButtonElement>('#fetch-button').disabled = !this.opened;
    if (!data) return;
    autoFetch.done(root);
    if (root !== this.root) return;
    this.setSyncError(null);
    this.update(data.status, data.graph, data.refs);
    const behind = data.refs.local.filter((ref) => ref.behind).map((ref) => `${ref.name} ↓${ref.behind}`);
    this.message(`Fetch terminé. ${behind.length ? `En retard sur la distante : ${behind.join(', ')}.` : 'Les branches suivies sont à jour.'}`);
  },
  folderMenu(x: number, y: number) {
    const remotes = this.refs.remotes || [];
    showMenu([
      ['Ouvrir le dossier dans l’explorateur', () => this.invoke(() => window.workbench.openFolder(ui.repo))],
      ['Ouvrir un terminal ici', async () => { if (await this.invoke(() => window.workbench.openTerminal(ui.repo)) === false) this.message('Aucun terminal trouvé sur ce système.'); }],
      ['Ouvrir dans l’éditeur intégré', () => this.showEditor()],
      null,
      ...remotes.filter((remote) => remote.web).map((remote): MenuEntry => [`Ouvrir ${remote.name} sur ${remote.host}`, () => this.invoke(() => window.workbench.openRemote(ui.repo, remote.name))]),
      remotes.some((remote) => remote.web) ? null : undefined,
      ['Ajouter un dépôt distant…', () => this.editRemote()],
      ['Copier le chemin du dépôt', () => this.copy(this.repo, 'Chemin copié')],
    ], x, y);
  },
  async checkout(branch: string) {
    // Git n'extrait une branche que dans une seule worktree : on propose d'ouvrir celle-ci plutôt qu'un refus brut.
    const elsewhere = this.findRef('local', branch)?.worktree;
    if (elsewhere) {
      if (await confirmDialog({ title: 'Branche extraite ailleurs', message: `« ${branch} » est déjà extraite dans la worktree ${elsewhere}. Git n’autorise qu’une worktree par branche : basculer ici est impossible.\n\nOuvrir cette worktree dans un onglet ?` })) await this.openWorktree(elsewhere);
      return;
    }
    if (await this.act(() => window.workbench.switchBranch(ui.repo, branch))) { await this.reload(); this.message(`Branche courante : ${branch}.`); }
  },
  async showCommitDiff(hash: string, filePath: string) {
    if (!await this.leaveDiff()) return;
    const data = await this.invoke(() => window.workbench.commitVersions(ui.repo, hash, filePath));
    if (data === null) return;
    this.detailFile = filePath;
    this.renderPanel();
    const back = document.createElement('button');
    back.className = 'chip-toggle';
    back.textContent = 'Tous les fichiers';
    back.title = 'Revenir à la revue de tout le commit';
    back.addEventListener('click', () => this.showCommitReview(hash, filePath));
    this.renderDiff(filePath, data, `${filePath} · ${hash.slice(0, 7)}`, this.details?.hash === hash ? [back] : []);
  },
  // Revue du commit : tous ses fichiers modifiés l'un sous l'autre ; sur un fichier, la revue défile jusqu'à lui.
  async showCommitReview(hash: string, filePath: string | null = null) {
    if (this.details?.hash !== hash) return;
    if (!await this.leaveDiff()) return;
    this.detailFile = filePath;
    this.renderPanel();
    if (this.view === 'review' && monacoViews?.reviewedCommit() === hash) {
      if (filePath) monacoViews.revealReviewFile(filePath);
      return;
    }
    const { showReview } = await views();
    const details = this.details;
    this.setView('review', `${hash.slice(0, 7)} · ${details.message.split('\n')[0]}`);
    showReview($('#review-view'), $('#view-tools'), {
      details,
      focusPath: filePath,
      load: (path) => this.invoke(() => window.workbench.commitVersions(ui.repo, hash, path)),
      onOpenFile: (path) => this.showCommitDiff(hash, path),
    });
  },
  // Sans `staged`, côté indexé seulement si le fichier n'a plus rien de non indexé.
  async showDiff(filePath: string, staged?: boolean) {
    staged ??= this.files.find((file) => file.path === filePath)?.staged === true && !this.files.find((file) => file.path === filePath)?.unstaged;
    if (!await this.leaveDiff()) return;
    const file = this.files.find((item) => item.path === filePath);
    if (file?.conflicted) { await this.showConflict(filePath); return; }
    const data = await this.invoke(() => window.workbench.versions(ui.repo, filePath, staged));
    if (data === null) return;
    this.selected = filePath;
    this.renderPanel();
    const button = (label: string, title: string, action: () => void, className = 'chip-toggle') => {
      const node = document.createElement('button'); node.className = className; node.textContent = label; node.title = title;
      node.addEventListener('click', action);
      return node;
    };
    const actions: HTMLButtonElement[] = [];
    if (file) actions.push(button(staged ? 'Désindexer le fichier' : 'Indexer le fichier', staged ? 'Retirer tout ce fichier de l’index' : 'Ajouter tout ce fichier à l’index', () => this.toggleStage(file), 'button compact stage-all'));
    // Blocs et lignes (A3) : pas pour un fichier renommé ni en conflit, que seul le fichier entier peut indexer.
    const lines: DiffOptions['lines'] = file && !file.originalPath ? { verb: staged ? 'Désindexer' : 'Indexer', apply: (request: LineStagingRequest) => this.applyLines(filePath, staged, request) } : null;
    if (file && file.worktreeStatus !== 'D') {
      actions.push(button('Éditeur', 'Ouvrir le fichier dans l’éditeur intégré', () => this.showEditor(filePath)));
      actions.push(button('Dossier', 'Afficher le fichier dans l’explorateur', () => this.invoke(() => window.workbench.showFile(ui.repo, filePath))));
    }
    this.renderDiff(filePath, data, `${filePath} · ${staged ? 'indexé (HEAD → index)' : 'non indexé (index → fichier)'}`, actions, async (content) => {
      const status = await this.act(() => window.workbench.writeFile(ui.repo, filePath, content));
      if (!status) return false;
      this.update(status);
      this.editor?.reloadClean(filePath);
      this.message(`${filePath} enregistré.`);
      return true;
    }, lines);
  },
  async renderDiff(filePath: string, data: DiffOptions['data'], title: string, actions: HTMLElement[], onSave?: DiffOptions['onSave'], lines: DiffOptions['lines'] = null) {
    const { showDiff } = await views();
    this.setView('diff', title);
    showDiff($('#diff-view'), $('#view-tools'), { path: filePath, data, actions, onSave, lines });
  },
  // Indexe ou désindexe un bloc ou des lignes, puis recharge le diff (même en cas de refus : il a pu changer sur disque).
  // Quand il ne reste rien de ce côté, la vue passe à l'autre (non indexé → indexé ou l'inverse).
  async applyLines(filePath: string, staged: boolean, request: LineStagingRequest) {
    const status = await this.applyStatus(() => (staged ? window.workbench.unstageLines(ui.repo, filePath, request) : window.workbench.stageLines(ui.repo, filePath, request)));
    if (status) this.message(staged ? `Lignes retirées de l’index : ${filePath}.` : `Lignes ajoutées à l’index : ${filePath}.`);
    const updated = this.files.find((item) => item.path === filePath);
    if (!updated || this.selected !== filePath || this.view !== 'diff') return;
    await this.showDiff(filePath, (staged ? updated.staged : updated.unstaged) ? staged : !staged);
  },
  async copy(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); this.message(`${label} : ${text}.`); }
    catch { this.message('Copie impossible dans le presse-papiers.'); }
  },
  async createBranch(startPoint: string | null = null) {
    const name = await askText({
      title: startPoint ? 'Créer une branche ici' : 'Nouvelle branche',
      label: 'NOM DE LA BRANCHE',
      confirmLabel: 'Créer',
      hint: startPoint ? `La branche pointera sur ${startPoint.slice(0, 7)} ; la branche courante ne change pas.` : `Créée depuis le HEAD de « ${this.branch} », puis la branche courante.`,
    });
    if (!name) return;
    if (await this.act(() => window.workbench.createBranch(ui.repo, name, startPoint))) { await this.reload(); this.message(`Branche « ${name} » créée.`); }
  },
  async renameBranch(ref: RefTarget) {
    const choice = await askRename({ name: ref.name, upstream: ref.upstream && !ref.gone ? ref.upstream : null });
    if (!choice) return;
    const result = await this.act(() => window.workbench.renameBranch(ui.repo, ref.name, choice.name, choice.remote));
    // Rechargée même après un refus : un renommage distant à moitié fait a déjà changé le nom local.
    await this.reload();
    if (!result) return;
    if (result.remote?.oldBranchKept) {
      const text = describeCode('remote-old-branch-kept');
      this.message(text);
      await alertDialog({ title: 'Renommage partiel', message: text });
      return;
    }
    this.message(result.remote ? `Branche « ${ref.name} » renommée « ${result.branch} », aussi sur ${result.remote.name}.` : `Branche « ${ref.name} » renommée « ${result.branch} ».`);
  },
  // Une worktree introuvable ne s'ouvre pas (worktree-not-found) : on oriente vers « Oublier les worktrees introuvables ».
  async openWorktree(folder: string) {
    if ((this.refs.worktrees || []).some((item) => item.prunable && item.path === folder)) {
      this.message(`La worktree ${folder} est introuvable : elle ne peut pas être ouverte.`);
      await this.pruneWorktrees();
      return;
    }
    const data = await this.act(() => window.workbench.openWorktree(ui.repo, folder));
    if (data) this.open(data, `Worktree ${repositoryName(data.root)} ouverte.`);
  },
  // Sans branche : demande une branche libre ou un nouveau nom ; le dossier vient ensuite du dialogue natif.
  async createWorktree(branch: string | null = null) {
    const free = this.refs.local.filter((ref) => !ref.current && !ref.worktree).map((ref) => ref.name);
    const choice = branch ? { branch, newBranch: false } : await askWorktree({ branches: free, base: this.branch });
    if (!choice) return;
    const result = await this.act(() => window.workbench.addWorktree(ui.repo, choice.branch, choice.newBranch));
    if (!result) return;
    await this.reload();
    this.message(`Worktree « ${result.branch} » créée dans ${result.path}. Double-clic dessus pour l’ouvrir.`);
  },
  async removeWorktree(worktree: Worktree) {
    const result = await this.act(() => window.workbench.removeWorktree(ui.repo, worktree.path));
    if (!result) return;
    // L'onglet de la worktree supprimée disparaît : ses brouillons et ses modèles d'éditeur aussi, comme à la fermeture.
    for (const root of [worktree.path, ...this.tabs.filter((tab) => !result.tabs.includes(tab))]) {
      this.drafts.delete(root);
      this.editor?.forget(root);
    }
    this.tabs = result.tabs;
    this.renderTabs();
    await this.reload();
    this.message(`Worktree ${worktree.path} supprimée${worktree.branch ? ` ; la branche « ${worktree.branch} » est conservée` : ''}.`);
  },
  async pruneWorktrees() {
    if (await this.act(() => window.workbench.pruneWorktrees(ui.repo))) { await this.reload(); this.message('Worktrees introuvables oubliées (git worktree prune).'); }
  },
  worktreeMenu(worktree: Worktree, x: number, y: number) {
    const prunable = (this.refs.worktrees || []).some((item) => item.prunable);
    showMenu([
      ['Ouvrir dans un onglet', () => this.openWorktree(worktree.path), worktree.current || Boolean(worktree.prunable)],
      ['Nouvelle worktree…', () => this.createWorktree()],
      prunable ? ['Oublier les worktrees introuvables (prune)', () => this.pruneWorktrees()] : undefined,
      null,
      ['Copier le chemin', () => this.copy(worktree.path, 'Chemin copié')],
      ['Supprimer la worktree…', () => this.removeWorktree(worktree), worktree.main || worktree.current || Boolean(worktree.locked)],
    ], x, y);
  },
  async cherryPick(hash: string) {
    const result = await this.act(() => window.workbench.cherryPick(ui.repo, hash));
    if (result) { await this.reload(); this.message(`Cherry-pick terminé. Récupération conservée : ${result.recoveryRef}.`); }
  },
  // Commit inverse ; pour un merge, l'utilisateur choisit le parent gardé. Un conflit ouvre la résolution habituelle.
  async revert(commit: Commit) {
    let mainline: number | null = null;
    if (commit.parents.length > 1) {
      const describe = (hash: string) => this.graph.commits.find((item) => item.hash === hash)?.subject || '';
      mainline = await askChoice({
        title: `Revert du merge ${commit.hash.slice(0, 7)}`,
        message: 'Ce commit est un merge : choisissez le parent dont la version est gardée. Les changements apportés par les autres parents seront annulés.',
        options: commit.parents.map((hash, index) => ({ value: index + 1, label: `Parent ${index + 1} · ${hash.slice(0, 7)} ${describe(hash)}` })),
        confirmLabel: 'Revert',
      });
      if (!mainline) return;
    }
    const result = await this.act(() => window.workbench.revert(ui.repo, commit.hash, mainline));
    await this.reload();
    if (result) this.message(`Revert créé (${result.hash.slice(0, 7)}). Récupération conservée : ${result.recoveryRef}.`);
  },
  async createTag(hash: string) {
    const tag = await askTag({ target: hash.slice(0, 7) });
    if (!tag) return;
    if (await this.act(() => window.workbench.createTag(ui.repo, tag.name, hash, tag))) { await this.reload(); this.message(`Tag ${tag.annotated ? 'annoté' : 'léger'} « ${tag.name} » créé.`); }
  },
  async pushTag(name: string, remote: string) {
    const result = await this.act(() => window.workbench.pushTag(ui.repo, name, remote));
    if (result) this.message(`Tag « ${name} » poussé vers ${remote} (${result.hash.slice(0, 12)}).`);
  },
  async rebase(onto: string) {
    const result = await this.act(() => window.workbench.rebase(ui.repo, onto));
    if (result) { await this.reload(); this.message(`Rebase terminé. Récupération conservée : ${result.recoveryRef}.`); }
  },
  fillCommitMessage(message: string) {
    const [summary, ...body] = message.split('\n');
    summaryInput().value = summary;
    descriptionInput().value = body.join('\n').trim();
    this.updateComposer();
    summaryInput().focus();
  },
  // Après un rebase arrêté sur un commit à découper : on explique la suite et on propose son message.
  splitStarted(recoveryRef: string) {
    const { split } = this;
    if (!split) return;
    if (!summaryInput().value.trim()) this.fillCommitMessage(split.message);
    this.message(`Commit ${split.shortHash} retiré : ses changements sont à recommitter en plusieurs morceaux, puis Continuer. Récupération conservée : ${recoveryRef}.`);
  },
  async splitCommit(hash: string) {
    const result = await this.act(() => window.workbench.splitCommit(ui.repo, hash));
    if (!result) return;
    await this.reload();
    if (this.split) this.splitStarted(result.recoveryRef);
  },
  async interactiveRebase(onto: string, label: string) {
    const data = await this.act(() => window.workbench.interactiveRebaseCommits(ui.repo, onto));
    if (!data) return;
    if (!data.commits.length) { this.message(`Aucun commit de « ${this.branch} » à réorganiser au-dessus de ${label}.`); return; }
    const plan = await editRebasePlan({ base: label, branch: this.branch, commits: data.commits });
    if (!plan) return;
    const result = await this.act(() => window.workbench.interactiveRebase(ui.repo, onto, plan));
    if (!result) return;
    await this.reload();
    if (this.split) this.splitStarted(result.recoveryRef);
    else this.message(`Rebase interactif terminé. Récupération conservée : ${result.recoveryRef}.`);
  },
  // Les commits entrants s'affichent avant tout changement ; un refus (conflit compris) recharge la vue pour montrer
  // l'opération en cours.
  async merge(source: string, label = source) {
    const preview = await this.act(() => window.workbench.mergePreview(ui.repo, source));
    if (!preview) return;
    if (!preview.total) { this.message(`« ${this.branch} » contient déjà tous les commits de « ${label} ».`); return; }
    const choice = await confirmMerge({ source: label, branch: this.branch, preview });
    if (!choice) return;
    const result = await this.act(() => window.workbench.merge(ui.repo, source, preview.target, choice.fastForward));
    await this.reload();
    if (result) this.message(`${result.fastForwarded ? 'Fast-forward' : 'Merge'} de « ${label} » terminé. Récupération conservée : ${result.recoveryRef}.`);
  },
  // Dépôt et branche capturés avant l'attente : après un changement d'onglet, rien n'est affiché ni proposé dans l'autre.
  async pull() {
    const { repo: root, branch, upstream } = this;
    if (!upstream) return;
    $<HTMLButtonElement>('#pull-button').disabled = true;
    this.message(`Pull depuis ${upstream}…`);
    const result = await this.act(() => window.workbench.pull(root, upstream));
    if (root !== this.root) return;
    await this.reload();
    if (!result || root !== this.root) return;
    if (result.pulled) { this.message(`Pull terminé : ${result.behind} commit(s) intégré(s) en fast-forward. Récupération conservée : ${result.recoveryRef}.`); return; }
    if (!result.diverged) { this.message(`« ${branch} » est à jour avec ${result.upstream}${result.ahead ? ` (${result.ahead} commit(s) à pousser)` : ''}.`); return; }
    const choice = await chooseIntegration({ branch, ...result });
    if (root !== this.root) return;
    if (choice === 'merge') await this.merge(result.upstream);
    else if (choice === 'rebase') await this.rebase(result.upstream);
  },
  // Push et push forcé ne sont proposés qu'avec un upstream (bouton et menu désactivés sinon).
  async push() {
    const { upstream } = this;
    if (!upstream) return;
    const result = await this.act(() => window.workbench.push(ui.repo, upstream));
    if (result) { await this.reload(); this.message(`Push vérifié vers ${result.upstream} (${result.hash.slice(0, 12)}).`); }
  },
  // Lease périmé : l'upstream a bougé depuis le dernier fetch, on propose de le récupérer plutôt que de réessayer.
  async forcePush() {
    const { upstream } = this;
    if (!upstream) return;
    let result;
    try { result = await window.workbench.forcePush(ui.repo, upstream); }
    catch (error) {
      const text = describeError(error);
      this.message(text);
      if (errorCode(error) !== 'force-push-stale') await alertDialog({ title: 'Opération refusée', message: text });
      else if (await confirmDialog({ title: 'L’upstream a changé', message: `${text}\n\nRécupérer maintenant les branches distantes ?` })) await this.fetch();
      return;
    }
    if (result) { await this.reload(); this.message(`Push forcé vérifié vers ${result.upstream} (${result.hash.slice(0, 12)}). Anciens commits distants conservés : ${result.recoveryRef}.`); }
  },
  // Ajout (sans `remote`) ou changement d'URL : un refus réaffiche le formulaire avec sa raison.
  async editRemote(remote: Remote | null = null) {
    let values = { name: remote ? null : '', url: remote?.url ?? '' };
    let error = '';
    for (;;) {
      const answer = await askRemote({ ...values, error, title: remote ? `URL de « ${remote.name} »` : 'Ajouter un dépôt distant', confirmLabel: remote ? 'Enregistrer' : 'Ajouter' });
      if (!answer) return;
      values = answer;
      try {
        if (remote) await window.workbench.setRemoteUrl(ui.repo, remote.name, answer.url);
        else await window.workbench.addRemote(ui.repo, answer.name ?? '', answer.url);
      } catch (failure) { error = describeError(failure); continue; }
      await this.reload();
      this.message(remote ? `URL de « ${remote.name} » changée.` : `Dépôt distant « ${answer.name} » ajouté. Récupérez-le (fetch) pour voir ses branches.`);
      return;
    }
  },
  async renameRemote(name: string) {
    const newName = await askText({ title: `Renommer « ${name} »`, label: 'NOUVEAU NOM', value: name, confirmLabel: 'Renommer', hint: 'Les branches distantes et l’upstream des branches locales suivent le nouveau nom.' });
    if (!newName || newName === name) return;
    if (await this.act(() => window.workbench.renameRemote(ui.repo, name, newName))) { await this.reload(); this.message(`Dépôt distant « ${name} » renommé en « ${newName} ».`); }
  },
  async removeRemote(name: string) {
    if (await this.act(() => window.workbench.removeRemote(ui.repo, name))) { await this.reload(); this.message(`Dépôt distant « ${name} » retiré.`); }
  },
  async remoteMenu(name: string, x: number, y: number) {
    const remote = (await this.invoke(() => window.workbench.remotes(ui.repo)))?.find((item) => item.name === name);
    if (!remote) return;
    const site = (this.refs.remotes || []).find((item) => item.name === name && item.web);
    showMenu([
      [remote.credentials ? `Changer l’URL (elle contient des identifiants)…` : `Changer l’URL de « ${name} »…`, () => this.editRemote(remote)],
      [`Renommer « ${name} »…`, () => this.renameRemote(name)],
      [`Retirer « ${name} »…`, () => this.removeRemote(name)],
      null,
      site ? [`Ouvrir ${name} sur ${site.host}`, () => this.invoke(() => window.workbench.openRemote(ui.repo, name))] : undefined,
      ['Ajouter un dépôt distant…', () => this.editRemote()],
    ], x, y);
  },
  commitMenu(commit: Commit, x: number, y: number) {
    const short = commit.hash.slice(0, 7);
    this.selectCommit(commit.hash);
    showMenu([
      ['Créer une branche ici…', () => this.createBranch(commit.hash)],
      ['Cherry-pick ce commit', () => this.cherryPick(commit.hash)],
      [commit.parents.length > 1 ? 'Revert ce merge…' : 'Revert ce commit', () => this.revert(commit)],
      ['Créer un tag ici…', () => this.createTag(commit.hash)],
      [`Merger ${short} dans « ${this.branch} »…`, () => this.merge(commit.hash, short)],
      [`Rebaser « ${this.branch} » sur ${short}`, () => this.rebase(commit.hash)],
      [`Rebase interactif de « ${this.branch} » depuis ${short}…`, () => this.interactiveRebase(commit.hash, short)],
      ['Découper ce commit…', () => this.splitCommit(commit.hash), commit.parents.length !== 1],
      null,
      ['Copier le SHA', () => this.copy(commit.hash, 'SHA copié')],
      ['Copier le message', () => this.copy(commit.summary ? `${commit.subject}\n\n${commit.summary}` : commit.subject, 'Message copié')],
    ], x, y);
  },
  refMenu(kind: RefKind, ref: RefTarget, x: number, y: number) {
    const isCurrent = kind === 'local' && ref.name === this.branch;
    const items: MenuEntry[] = [];
    const worktree = kind === 'local' ? this.findRef('local', ref.name)?.worktree : null;
    // Une worktree introuvable (dossier supprimé ou disque débranché) ne s'ouvre pas : on propose de l'oublier.
    const missing = worktree && (this.refs.worktrees || []).some((item) => item.branch === ref.name && item.prunable);
    if (missing) items.push([`Oublier les worktrees introuvables (dont ${repositoryName(worktree)})`, () => this.pruneWorktrees()]);
    else if (worktree) items.push([`Ouvrir sa worktree (${repositoryName(worktree)})`, () => this.openWorktree(worktree)]);
    else if (kind === 'local' && !isCurrent) items.push([`Basculer sur « ${ref.name} »`, () => this.checkout(ref.name)]);
    if (kind === 'local' && !isCurrent && !worktree) items.push([`Créer une worktree pour « ${ref.name} »…`, () => this.createWorktree(ref.name)]);
    if (kind === 'remote') {
      const remote = this.findRef('remote', ref.name) || ref;
      const { trackedBy } = remote;
      if (trackedBy) items.push([`Basculer sur « ${trackedBy} » (qui la suit)`, () => this.checkout(trackedBy), trackedBy === this.branch]);
      else items.push([`Créer « ${remote.branch || ref.name} » en local et basculer`, () => this.checkoutRemote(ref.name)]);
    }
    if (isCurrent) items.push([this.upstream ? `Pull depuis ${this.upstream}` : 'Pull (upstream non configuré)', () => this.pull(), !this.upstream]);
    if (isCurrent) items.push([this.upstream ? `Push vers ${this.upstream}` : 'Push (upstream non configuré)', () => this.push(), !this.upstream]);
    if (isCurrent && this.upstream) items.push([`Push forcé (lease) vers ${this.upstream}…`, () => this.forcePush()]);
    if (!isCurrent) items.push([`Merger « ${ref.name} » dans « ${this.branch} »…`, () => this.merge(ref.name)]);
    if (kind !== 'tags' && !isCurrent) {
      items.push([`Rebaser « ${this.branch} » sur « ${ref.name} »`, () => this.rebase(ref.name)]);
      items.push([`Rebase interactif de « ${this.branch} » sur « ${ref.name} »…`, () => this.interactiveRebase(ref.name, ref.name)]);
    }
    if (ref.hash) items.push(['Créer une branche ici…', () => this.createBranch(ref.hash)]);
    if (kind === 'local') items.push(['Renommer…', () => this.renameBranch(this.findRef('local', ref.name) || ref)]);
    if (kind === 'tags') for (const remote of this.refs.remotes || []) items.push([`Pousser le tag vers ${remote.name}`, () => this.pushTag(ref.name, remote.name)]);
    // Page de la branche sur GitHub/GitLab : distante elle-même, ou upstream d'une branche locale.
    const remoteRef = kind === 'remote' ? this.findRef('remote', ref.name) : kind === 'local' && ref.upstream ? this.findRef('remote', ref.upstream) : null;
    const site = remoteRef && (this.refs.remotes || []).find((item) => item.name === remoteRef.remote && item.web);
    if (site) items.push([`Ouvrir la branche sur ${site.host}`, () => this.invoke(() => window.workbench.openRemote(ui.repo, site.name, remoteRef.branch))]);
    items.push(null, ['Copier le nom', () => this.copy(ref.name, 'Nom copié')]);
    showMenu(items, x, y);
  },
};

const chooseRepository = async () => ui.open(await ui.invoke(() => window.workbench.chooseRepository()));
$('#open-repo').addEventListener('click', chooseRepository);
$('#empty-open').addEventListener('click', chooseRepository);
$('#new-tab').addEventListener('click', chooseRepository);
// Menu de l'application (remplace la barre de menu native) et ses raccourcis.
const windowAction = (action: Parameters<Api['windowAction']>[0]) => ui.invoke(() => window.workbench.windowAction(action));
// Une version plus récente trouvée (au démarrage ou depuis la fenêtre) est signalée par une pastille sur le menu.
const setUpdate = (found: UpdateCheck | null) => {
  ui.pendingUpdate = found?.available ? found : null;
  $('#app-menu').classList.toggle('has-update', Boolean(ui.pendingUpdate));
};
const appMenu = () => {
  const box = $('#app-menu').getBoundingClientRect();
  showMenu([
    ['Ouvrir un dépôt…', chooseRepository, false, 'Ctrl+O'],
    ['Fermer l’onglet', () => ui.closeTab(ui.repo), !ui.opened],
    null,
    ['Graphe', () => ui.showGraph(), !ui.opened],
    ['Éditeur', () => ui.showEditor(), !ui.opened, 'Ctrl+P'],
    null,
    ['Zoom avant', () => windowAction('zoom-in'), false, 'Ctrl+='],
    ['Zoom arrière', () => windowAction('zoom-out'), false, 'Ctrl+-'],
    ['Taille normale', () => windowAction('zoom-reset'), false, 'Ctrl+0'],
    ['Plein écran', () => windowAction('fullscreen'), false, 'F11'],
    null,
    ['Extensions VS Code…', () => openExtensions().catch((error) => ui.message(describeError(error), true))],
    [`Fetch automatique${autoFetch.settings.autoFetch ? ` (${autoFetch.settings.intervalMinutes} min)` : ' (désactivé)'}…`, () => autoFetch.configure()],
    [ui.pendingUpdate?.latest ? `Mise à jour disponible (${ui.pendingUpdate.latest.version})…` : 'Mises à jour…', () => openUpdates({ check: Boolean(ui.pendingUpdate), onResult: setUpdate })],
    ['Recharger la fenêtre', () => windowAction('reload')],
    import.meta.env.DEV ? ['Outils de développement', () => windowAction('devtools'), false, 'Ctrl+Maj+I'] : undefined,
    null,
    ['Quitter', () => windowAction('quit')],
  ], box.left, box.bottom + 4);
};
$('#app-menu').addEventListener('click', (event) => { event.stopPropagation(); appMenu(); });
document.addEventListener('keydown', (event) => {
  if (document.querySelector('dialog[open]')) return;
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const shortcut = ctrl && key === 'o' ? chooseRepository
    : ctrl && (key === '=' || key === '+') ? () => windowAction('zoom-in')
      : ctrl && key === '-' ? () => windowAction('zoom-out')
        : ctrl && key === '0' ? () => windowAction('zoom-reset')
          : event.key === 'F11' ? () => windowAction('fullscreen')
            : import.meta.env.DEV && ctrl && event.shiftKey && key === 'i' ? () => windowAction('devtools') : null;
  if (!shortcut) return;
  event.preventDefault();
  shortcut();
});

// Fetch automatique en arrière-plan : toutes les N minutes, à l'ouverture d'un onglet et au retour sur la fenêtre.
// Silencieux s'il réussit (seuls le graphe, les branches et ↑↓ bougent), un point discret sur Fetch s'il échoue.
// Ni pull ni merge : la branche courante n'avance que par le bouton Pull.
const FETCH_INTERVALS = [1, 2, 5, 10, 15, 30, 60];
const FOCUS_DEBOUNCE = 1500;
// Hors minuterie, pas de nouveau fetch si le précédent de cet onglet a moins d'une minute.
const FETCH_MIN_GAP = 60 * 1000;
const autoFetch = {
  settings: { autoFetch: true, intervalMinutes: 5 } as SyncSettings,
  loading: null as Promise<void> | null,
  timer: undefined as ReturnType<typeof setInterval> | undefined,
  focusTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  last: new Map<string, number>(),
  errors: new Map<string | null, unknown>(),
  load() {
    this.loading ??= ui.invoke(() => window.workbench.syncSettings()).then((settings) => { if (settings) this.settings = settings; this.schedule(); });
    return this.loading;
  },
  schedule() {
    clearInterval(this.timer);
    this.timer = this.settings.autoFetch ? setInterval(() => this.run(ui.root, { reason: 'interval' }), this.settings.intervalMinutes * 60 * 1000) : undefined;
  },
  done(root: string) { this.last.set(root, Date.now()); this.errors.delete(root); },
  async run(root: string | null, { reason }: { reason: 'open' | 'interval' | 'focus' }) {
    if (root === ui.root) ui.setSyncError(this.errors.get(root) ?? null);
    await this.load();
    if (!root || !this.settings.autoFetch || (root === ui.root && ui.operation)) return;
    if (reason !== 'interval' && Date.now() - (this.last.get(root) || 0) < FETCH_MIN_GAP) return;
    this.last.set(root, Date.now());
    const generation = ui.generation;
    let data;
    try { data = await window.workbench.fetch(root, true); }
    catch (error) {
      this.errors.set(root, error);
      if (root === ui.root) ui.setSyncError(error);
      return;
    }
    if (data.skipped) return;
    this.errors.delete(root);
    if (root !== ui.root) return;
    ui.setSyncError(null);
    // Un état plus récent (commit, changement d'onglet…) a été affiché pendant le fetch : son instantané, pris avant,
    // l'écraserait. On en relit un frais, lui aussi écarté si l'état bouge encore entre-temps.
    if (ui.generation !== generation) {
      const seen = ui.generation;
      const fresh = await window.workbench.refresh(root).catch(() => null);
      if (!fresh || root !== ui.root || ui.generation !== seen) return;
      data = fresh;
    }
    // Rien de neuf côté distant : on ne redessine pas sous les yeux de l'utilisateur.
    if (JSON.stringify(data.refs) !== JSON.stringify(ui.refs)) ui.update(data.status, data.graph, data.refs);
  },
  onFocus() {
    clearTimeout(this.focusTimer);
    this.focusTimer = setTimeout(() => this.run(ui.root, { reason: 'focus' }), FOCUS_DEBOUNCE);
  },
  async configure() {
    await this.load();
    const enabled = element('input');
    enabled.type = 'checkbox';
    enabled.checked = this.settings.autoFetch;
    const enabledLabel = element('label', 'update-startup');
    enabledLabel.append(enabled, ' Récupérer automatiquement les branches distantes');
    const interval = element('select');
    for (const minutes of FETCH_INTERVALS) {
      const option = element('option', '', minutes === 1 ? 'Toutes les minutes' : `Toutes les ${minutes} minutes`);
      option.value = String(minutes);
      interval.append(option);
    }
    interval.value = String(this.settings.intervalMinutes);
    const field = element('label', 'dialog-field');
    field.append(element('span', 'eyebrow', 'FRÉQUENCE'), interval);
    const hint = element('p', 'dialog-hint', 'Aussi à l’ouverture d’un dépôt et au retour sur la fenêtre. Seules les branches distantes sont mises à jour : la branche courante n’avance que par Pull, en avance rapide. Aucune invite d’identifiants n’est ouverte en arrière-plan.');
    const changes = await modal('Fetch automatique', [enabledLabel, field, hint], {
      confirmLabel: 'Enregistrer',
      collect: () => ({ autoFetch: enabled.checked, intervalMinutes: Number(interval.value) }),
    });
    if (!changes) return;
    const saved = await ui.invoke(() => window.workbench.setSyncSettings(changes));
    if (!saved) return;
    this.settings = saved;
    this.schedule();
    ui.message(saved.autoFetch ? `Fetch automatique toutes les ${saved.intervalMinutes} min.` : 'Fetch automatique désactivé.');
  },
};
window.addEventListener('focus', () => autoFetch.onFocus());

// Au lancement : rouvre les onglets de la session précédente et l'onglet qui était actif.
(async () => {
  const session = await ui.invoke(() => window.workbench.restoreSession());
  if (!session?.snapshot) return;
  ui.tabs = session.tabs;
  ui.open(session.snapshot);
})();
// Recherche de mise à jour au démarrage, seulement si elle a été activée dans « Mises à jour… ».
checkOnStartup().then((found) => {
  setUpdate(found);
  if (ui.pendingUpdate?.latest) ui.message(`BranchBrace ${ui.pendingUpdate.latest.version} est disponible : menu ☰ › Mise à jour disponible.`);
});
$('#refresh').addEventListener('click', () => ui.reload());
$('#fetch-button').addEventListener('click', () => ui.fetch());
$('#pull-button').addEventListener('click', () => ui.pull());
$('#view-graph').addEventListener('click', () => ui.showGraph());
$('#view-editor').addEventListener('click', () => ui.showEditor());
const folderButton = $('#folder-button');
folderButton.addEventListener('click', (event) => { event.stopPropagation(); const box = folderButton.getBoundingClientRect(); ui.folderMenu(box.left, box.bottom + 4); });
amendToggle().addEventListener('change', () => ui.setAmend(amendToggle().checked));
$('#conventional-button').addEventListener('click', () => ui.conventional());
// Ctrl+P : ouverture rapide d'un fichier dans l'éditeur, depuis n'importe quelle vue.
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p' && ui.opened && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    ui.showEditor().then(() => ui.editor?.focusSearch());
  }
});
$('#push-button').addEventListener('click', () => ui.push());
$('#undo-button').addEventListener('click', () => ui.undo());
$('#redo-button').addEventListener('click', () => ui.redo());
// Ctrl+Z / Ctrl+Maj+Z (ou Ctrl+Y) hors d'un champ de saisie ou de l'éditeur, qui gardent leur propre annulation.
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || document.querySelector('dialog[open]')) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, .monaco-editor'))) return;
  const key = event.key.toLowerCase();
  const action = key === 'z' && !event.shiftKey ? () => ui.undo() : (key === 'z' && event.shiftKey) || key === 'y' ? () => ui.redo() : null;
  if (!action) return;
  event.preventDefault();
  action();
});
$('#new-branch').addEventListener('click', () => ui.createBranch());
$('#back-to-graph').addEventListener('click', () => ui.showGraph());
$('#ref-filter').addEventListener('input', () => ui.renderRefs());
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && ui.view === 'diff' && !document.querySelector('dialog[open]')) ui.showGraph(); });
summaryInput().addEventListener('input', () => ui.updateComposer());
summaryInput().addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !$<HTMLButtonElement>('#commit-button').disabled) $('#commit-button').click(); });
$('#commit-button').addEventListener('click', async () => {
  const summary = summaryInput().value.trim();
  const description = descriptionInput().value.trim();
  if (!summary) { ui.message('Un résumé de commit non vide est requis.'); return; }
  const message = description ? `${summary}\n\n${description}` : summary;
  if (ui.amend) {
    const result = await ui.act(() => window.workbench.amend(ui.repo, message));
    if (!result) return;
    ui.amend = null;
    amendToggle().checked = false;
    summaryInput().value = ''; descriptionInput().value = '';
    await ui.reload();
    ui.message(`Dernier commit amendé : ${result.hash.slice(0, 12)}. Ancienne version conservée : ${result.recoveryRef}.`);
    return;
  }
  const hash = await ui.act(() => window.workbench.commit(ui.repo, message));
  if (hash) {
    summaryInput().value = ''; descriptionInput().value = '';
    await ui.reload();
    ui.message(`Commit local créé : ${hash.slice(0, 12)}.`);
  }
});

window.workbench.onConfirmRequest(confirmDialog);
