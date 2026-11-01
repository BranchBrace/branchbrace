import { WIP, renderGraph } from './graph-view.js';
import { renderCommitDetails, renderWorkingChanges } from './details-view.js';
import { renderRefs } from './refs-view.js';
import { alertDialog, askText, confirmDialog, showMenu } from './dialogs.js';
import { editRebasePlan } from './rebase-editor.js';
import { chooseIntegration, confirmMerge } from './merge-dialog.js';
import { composeConventional } from './conventional-dialog.js';
import { knownScopes } from './conventional.js';
import { describeError } from './errors.js';
import { checkOnStartup, openUpdates } from './update-dialog.js';

const SUMMARY_LIMIT = 72;
const $ = (selector) => document.querySelector(selector);

const repositoryName = (root) => root.split(/[\\/]/).filter(Boolean).pop() || root;
// Monaco (plusieurs Mo) n'est chargé qu'à la première vue qui en a besoin : le graphe s'affiche sans l'attendre.
let monacoViews = null;
let viewsLoading = null;
const views = () => (viewsLoading ??= Promise.all([import('./diff-panel.js'), import('./editor-view.js'), import('./conflict-view.js'), import('./commit-review.js')])
  .then(([diff, editor, conflict, review]) => (monacoViews = { ...diff, ...editor, ...conflict, ...review })));
const OPERATION_NAMES = { rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', merge: 'Merge', revert: 'Revert' };

const ui = {
  opened: false,
  root: null,
  tabs: [],
  drafts: new Map(),
  branch: '',
  upstream: null,
  files: [],
  selected: null,
  graph: { head: null, commits: [] },
  refs: { local: [], remote: [], tags: [] },
  selectedCommit: WIP,
  details: null,
  detailFile: null,
  view: 'graph',
  operation: null,
  amend: null,
  editor: null,
  async invoke(action) {
    try { return await action(); }
    catch (error) { this.message(describeError(error), true); return null; }
  },
  // Commande lancée explicitement (menu, bouton) : un refus s'affiche dans une fenêtre, pas seulement dans la ligne de statut.
  async act(action) {
    try { return await action(); }
    catch (error) {
      const text = describeError(error);
      this.message(text);
      await alertDialog({ title: 'Opération refusée', message: text });
      return null;
    }
  },
  // Toast bref et non bloquant : le résultat d'une action se lit dans le graphe, le toast ne fait que le confirmer.
  message(text, error = false) {
    const toast = $('#status-message');
    toast.textContent = text;
    toast.classList.toggle('error', error);
    toast.classList.add('visible');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => toast.classList.remove('visible'), error ? 6000 : 3000);
  },
  // Affiche un dépôt (instantané renvoyé par le processus principal) dans son onglet, en gardant le brouillon de
  // commit de l'onglet quitté.
  open(data, message = null) {
    if (!data) return;
    if (this.root) this.drafts.set(this.root, { summary: $('#commit-summary').value, description: $('#commit-description').value });
    const draft = this.drafts.get(data.root) || { summary: '', description: '' };
    $('#commit-summary').value = draft.summary;
    $('#commit-description').value = draft.description;
    this.opened = true;
    this.root = data.root;
    if (!this.tabs.includes(data.root)) this.tabs.push(data.root);
    $('#repo-name').textContent = repositoryName(data.root);
    $('#open-repo').title = `${data.root}\nCliquer pour ouvrir un autre dépôt dans un nouvel onglet`;
    $('#empty-state').hidden = true;
    for (const id of ['#new-branch', '#refresh', '#fetch-button', '#folder-button', '#view-graph', '#view-editor']) $(id).disabled = false;
    this.selected = null;
    this.selectedCommit = WIP;
    this.details = null;
    this.setAmend(false);
    this.update(data.status, data.graph, data.refs);
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
  async activate(root) {
    if (root === this.root) return;
    const data = await this.invoke(() => window.workbench.activate(root));
    if (data) this.open(data, `Onglet ${repositoryName(root)}.`);
  },
  async closeTab(root) {
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
    for (const id of ['#new-branch', '#refresh', '#push-button', '#pull-button', '#fetch-button', '#folder-button', '#view-graph', '#view-editor']) $(id).disabled = true;
    this.setView(null);
    $('#operation-banner').hidden = true;
    $('#empty-state').hidden = false;
    $('#ref-tree').replaceChildren();
    this.renderPanel();
    this.renderTabs();
  },
  async reload() {
    const result = await this.invoke(() => window.workbench.refresh(ui.root));
    if (result) this.update(result.status, result.graph, result.refs);
    return result;
  },
  update(status, graph, refs) {
    this.files = status.files;
    this.branch = status.branch;
    this.upstream = status.upstream;
    this.operation = status.operation ?? null;
    if (graph) this.graph = graph;
    if (refs) this.refs = refs;
    $('#branch-name').textContent = status.branch;
    $('#push-button').disabled = !status.upstream;
    $('#push-button').title = status.upstream ? `Pousser vers ${status.upstream}` : 'Upstream non configuré';
    $('#pull-button').disabled = !status.upstream;
    $('#pull-button').title = status.upstream ? `Récupérer ${status.upstream} puis avancer la branche (fast-forward seul)` : 'Upstream non configuré';
    if (this.selectedCommit !== WIP && !this.graph.commits.some((commit) => commit.hash === this.selectedCommit)) { this.selectedCommit = WIP; this.details = null; }
    this.renderGraph();
    this.renderRefs();
    this.renderPanel();
    this.renderBanner();
    this.editor?.updateStatus(this.files);
  },
  // Zone centrale : graphe, diff d'un fichier, éditeur ou résolution d'un conflit (null : écran d'accueil).
  setView(view, title = '') {
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
  async showEditor(openPath = null) {
    if (!this.opened || !await this.leaveDiff()) return;
    const { createEditorView } = await views();
    this.editor ??= createEditorView($('#editor-view'), {
      api: window.workbench,
      message: (error, text) => this.message(error ? describeError(error) : text),
      confirm: confirmDialog,
      onSaved: () => this.reload(),
      onShowDiff: (filePath) => this.showDiff(filePath),
    });
    this.setView('editor');
    await this.editor.show(this.root, this.files);
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
    const strong = document.createElement('strong'); strong.textContent = `${name} en cours`;
    const detail = document.createElement('span');
    detail.textContent = conflicts.length
      ? ` — ${conflicts.length} fichier${conflicts.length > 1 ? 's' : ''} en conflit à résoudre, puis Continuer.`
      : ' — aucun conflit restant : vous pouvez continuer.';
    text.append(strong, detail);
    const button = (label, className, action, title) => {
      const node = document.createElement('button'); node.className = `button compact ${className}`; node.textContent = label; node.title = title;
      node.addEventListener('click', action);
      return node;
    };
    const actions = [];
    if (conflicts.length) actions.push(button('Résoudre le suivant', 'secondary', () => this.showConflict(conflicts[0].path), 'Ouvrir l’outil de fusion sur le premier fichier en conflit'));
    actions.push(button('Continuer', 'primary', () => this.continueOperation(), `git ${this.operation} --continue`));
    if (this.operation !== 'merge') actions.push(button('Passer ce commit', 'secondary', () => this.skipOperation(), `git ${this.operation} --skip`));
    actions.push(button('Annuler l’opération', 'danger', () => this.abortOperation(), `git ${this.operation} --abort`));
    banner.replaceChildren(text, ...actions);
    banner.hidden = false;
  },
  async continueOperation() {
    const result = await this.act(() => window.workbench.continueOperation(ui.root));
    await this.reload();
    if (result) this.message(this.operation ? `${OPERATION_NAMES[result.operation]} : nouvelle étape, de nouveaux conflits sont peut-être à résoudre.` : `${OPERATION_NAMES[result.operation]} terminé.`);
  },
  async skipOperation() {
    const result = await this.act(() => window.workbench.skipOperation(ui.root));
    if (result) { await this.reload(); this.message('Commit passé.'); }
  },
  async abortOperation() {
    const result = await this.act(() => window.workbench.abortOperation(ui.root));
    if (result) { await this.reload(); if (this.view === 'conflict') this.setView('graph'); this.message(`${OPERATION_NAMES[result.operation]} annulé : retour à l’état d’avant.`); }
  },
  async showConflict(filePath) {
    if (!await this.leaveDiff()) return;
    const [data, { showConflict: renderConflict }] = await Promise.all([this.invoke(() => window.workbench.conflictVersions(ui.root, filePath)), views()]);
    if (!data) return;
    this.selected = filePath;
    this.renderPanel();
    this.setView('conflict', `${filePath} · conflit`);
    renderConflict($('#conflict-view'), $('#view-tools'), {
      data,
      onClose: () => this.showGraph(),
      onResolve: async (content) => {
        const status = await this.act(() => window.workbench.resolveConflict(ui.root, filePath, content));
        if (!status) return;
        this.update(status);
        this.editor?.reloadClean(filePath);
        const next = this.files.find((file) => file.conflicted);
        if (next) { this.message(`${filePath} résolu. Conflit suivant : ${next.path}.`); await this.showConflict(next.path); return; }
        this.setView('graph');
        this.message(`${filePath} résolu. Plus aucun conflit : cliquez sur Continuer pour terminer le ${OPERATION_NAMES[this.operation] || 'travail'}.`);
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
      filter: $('#ref-filter').value,
      selectedHash: this.selectedCommit,
      onSelect: (hash) => this.revealCommit(hash),
      onActivate: (branch) => this.checkout(branch),
      onCheckoutRemote: (name) => this.checkoutRemote(name),
      onOpenRemote: (remote, branch) => this.invoke(() => window.workbench.openRemote(ui.root, remote, branch)),
      loadRemoteIcon: (remote) => window.workbench.remoteIcon(ui.root, remote),
      onContextMenu: (kind, ref, x, y) => this.refMenu(kind, ref, x, y),
    });
  },
  findRef(kind, name) { return this.refs[kind]?.find((ref) => ref.name === name); },
  async revealCommit(hash) {
    const row = document.querySelector(`.graph-row[data-hash="${hash}"]`);
    if (!row) { this.message('Ce commit est au-delà des 500 derniers affichés dans le graphe.'); return; }
    if (this.view !== 'graph') await this.showGraph();
    row.scrollIntoView({ block: 'center' });
    this.selectCommit(hash);
  },
  async selectCommit(hash) {
    this.selectedCommit = hash || WIP;
    this.details = null;
    this.detailFile = null;
    document.querySelectorAll('#graph-rows .graph-row').forEach((row) => row.classList.toggle('selected', row.dataset.hash === this.selectedCommit));
    if (this.selectedCommit !== WIP) {
      const details = await this.invoke(() => window.workbench.commitDetails(ui.root, hash));
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
      composer.hidden = true;
      renderCommitDetails(panel, this.details, {
        selectedFile: this.detailFile,
        onClose: () => this.selectCommit(WIP),
        onReview: () => this.showCommitReview(this.details.hash),
        onOpenFile: (file) => this.showCommitReview(this.details.hash, file.path),
        onFileMenu: (file, x, y) => showMenu([
          ['Voir dans la revue du commit', () => this.showCommitReview(this.details.hash, file.path)],
          ['Voir ce fichier seul', () => this.showCommitDiff(this.details.hash, file.path)],
          ['Ouvrir la version de travail dans l’éditeur', () => this.showEditor(file.path), file.status === 'D'],
          ['Afficher dans le dossier', () => this.invoke(() => window.workbench.showFile(ui.root, file.path)), file.status === 'D'],
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
      onStageAll: () => this.applyStatus(() => window.workbench.stageAll(ui.root)),
      onUnstageAll: () => this.applyStatus(() => window.workbench.unstageAll(ui.root)),
      onFileMenu: (file, staged, x, y) => showMenu(file.conflicted ? [
        ['Résoudre le conflit…', () => this.showConflict(file.path)],
        ['Ouvrir dans l’éditeur', () => this.showEditor(file.path)],
        null,
        ['Afficher dans le dossier', () => this.invoke(() => window.workbench.showFile(ui.root, file.path))],
        ['Copier le chemin', () => this.copy(file.path, 'Chemin copié')],
      ] : [
        [staged ? 'Retirer de l’index' : 'Ajouter à l’index', () => this.toggleStage(file)],
        ['Voir le diff', () => this.showDiff(file.path, staged)],
        ['Ouvrir dans l’éditeur', () => this.showEditor(file.path), file.worktreeStatus === 'D'],
        null,
        ['Afficher dans le dossier', () => this.invoke(() => window.workbench.showFile(ui.root, file.path)), file.worktreeStatus === 'D'],
        ['Copier le chemin', () => this.copy(file.path, 'Chemin copié')],
      ], x, y),
    });
    composer.hidden = false;
    this.updateComposer();
  },
  updateComposer() {
    const staged = this.files.filter((file) => file.staged).length;
    const summary = $('#commit-summary').value;
    const remaining = SUMMARY_LIMIT - summary.length;
    $('#summary-count').textContent = String(remaining);
    $('#summary-count').classList.toggle('over', remaining < 0);
    const button = $('#commit-button');
    const amending = Boolean(this.amend);
    $('#commit-composer').classList.toggle('amending', amending);
    $('#composer-label').textContent = amending ? 'Amender le dernier commit' : 'Commit';
    // Pas d'amend au milieu d'un rebase ou d'un cherry-pick : le dernier commit n'est pas encore celui de la branche.
    $('#amend-toggle').disabled = !this.graph.head || (Boolean(this.operation) && !amending);
    if (amending) {
      button.disabled = !summary.trim();
      button.textContent = !summary.trim() ? 'Saisissez un résumé' : staged ? `Amender avec ${staged} fichier${staged > 1 ? 's' : ''} indexé${staged > 1 ? 's' : ''}` : 'Amender le message';
      return;
    }
    button.disabled = !staged || !summary.trim();
    button.textContent = !staged ? 'Indexez des changements pour committer' : !summary.trim() ? 'Saisissez un résumé' : `Committer ${staged} fichier${staged > 1 ? 's' : ''}`;
  },
  // Amend : le message du dernier commit remplace le brouillon le temps de l'édition ; décocher rend le brouillon.
  async setAmend(enabled) {
    $('#amend-toggle').checked = enabled;
    if (enabled && !this.amend) {
      const message = await this.invoke(() => window.workbench.headMessage(ui.root));
      if (message === null) { $('#amend-toggle').checked = false; return; }
      this.amend = { summary: $('#commit-summary').value, description: $('#commit-description').value };
      const [summary, ...body] = message.split('\n');
      $('#commit-summary').value = summary;
      $('#commit-description').value = body.join('\n').trim();
    } else if (!enabled && this.amend) {
      $('#commit-summary').value = this.amend.summary;
      $('#commit-description').value = this.amend.description;
      this.amend = null;
    }
    this.updateComposer();
  },
  async conventional() {
    const result = await composeConventional({
      summary: $('#commit-summary').value,
      description: $('#commit-description').value,
      scopes: knownScopes(this.graph.commits.map((commit) => commit.subject)),
    });
    if (!result) return;
    $('#commit-summary').value = result.summary;
    $('#commit-description').value = result.description;
    this.updateComposer();
    $('#commit-summary').focus();
  },
  async applyStatus(action) {
    const status = await this.act(action);
    if (status) this.update(status);
    return status;
  },
  async toggleStage(file) {
    if (await this.applyStatus(() => file.staged ? window.workbench.unstage(ui.root, file.path) : window.workbench.stage(ui.root, file.path)) && this.selected === file.path && this.view === 'diff' && !monacoViews?.diffIsDirty()) {
      const updated = this.files.find((item) => item.path === file.path);
      if (updated) await this.showDiff(file.path, updated.staged && !updated.unstaged);
    }
  },
  async checkoutRemote(name) {
    const status = await this.act(() => window.workbench.checkoutRemote(ui.root, name));
    if (status) { await this.reload(); this.message(`Branche locale « ${status.branch} » créée : elle suit ${name}.`); }
  },
  async fetch() {
    $('#fetch-button').disabled = true;
    this.message('Récupération depuis les dépôts distants…');
    const data = await this.act(() => window.workbench.fetch(ui.root));
    $('#fetch-button').disabled = !this.opened;
    if (!data) return;
    this.update(data.status, data.graph, data.refs);
    const behind = data.refs.local.filter((ref) => ref.behind).map((ref) => `${ref.name} ↓${ref.behind}`);
    this.message(`Fetch terminé. ${behind.length ? `En retard sur la distante : ${behind.join(', ')}.` : 'Les branches suivies sont à jour.'}`);
  },
  folderMenu(x, y) {
    const remotes = this.refs.remotes || [];
    showMenu([
      ['Ouvrir le dossier dans l’explorateur', () => this.invoke(() => window.workbench.openFolder(ui.root))],
      ['Ouvrir un terminal ici', async () => { if (await this.invoke(() => window.workbench.openTerminal(ui.root)) === false) this.message('Aucun terminal trouvé sur ce système.'); }],
      ['Ouvrir dans l’éditeur intégré', () => this.showEditor()],
      null,
      ...remotes.filter((remote) => remote.web).map((remote) => [`Ouvrir ${remote.name} sur ${remote.host}`, () => this.invoke(() => window.workbench.openRemote(ui.root, remote.name))]),
      remotes.some((remote) => remote.web) ? null : undefined,
      ['Copier le chemin du dépôt', () => this.copy(this.root, 'Chemin copié')],
    ], x, y);
  },
  async checkout(branch) {
    if (await this.act(() => window.workbench.switchBranch(ui.root, branch))) { await this.reload(); this.message(`Branche courante : ${branch}.`); }
  },
  async showCommitDiff(hash, filePath) {
    if (!await this.leaveDiff()) return;
    const data = await this.invoke(() => window.workbench.commitVersions(ui.root, hash, filePath));
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
  async showCommitReview(hash, filePath = null) {
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
      load: (path) => this.invoke(() => window.workbench.commitVersions(ui.root, hash, path)),
      onOpenFile: (path) => this.showCommitDiff(hash, path),
    });
  },
  async showDiff(filePath, staged = this.files.find((file) => file.path === filePath)?.staged === true && !this.files.find((file) => file.path === filePath)?.unstaged) {
    if (!await this.leaveDiff()) return;
    const file = this.files.find((item) => item.path === filePath);
    if (file?.conflicted) { await this.showConflict(filePath); return; }
    const data = await this.invoke(() => window.workbench.versions(ui.root, filePath, staged));
    if (data === null) return;
    this.selected = filePath;
    this.renderPanel();
    const button = (label, title, action, className = 'chip-toggle') => {
      const node = document.createElement('button'); node.className = className; node.textContent = label; node.title = title;
      node.addEventListener('click', action);
      return node;
    };
    const actions = [];
    if (file) actions.push(button(staged ? 'Désindexer' : 'Indexer', staged ? 'Retirer ce fichier de l’index' : 'Ajouter ce fichier à l’index', () => this.toggleStage(file), 'button compact stage-all'));
    if (file && file.worktreeStatus !== 'D') {
      actions.push(button('Éditeur', 'Ouvrir le fichier dans l’éditeur intégré', () => this.showEditor(filePath)));
      actions.push(button('Dossier', 'Afficher le fichier dans l’explorateur', () => this.invoke(() => window.workbench.showFile(ui.root, filePath))));
    }
    this.renderDiff(filePath, data, `${filePath} · ${staged ? 'indexé (HEAD → index)' : 'non indexé (index → fichier)'}`, actions, async (content) => {
      const status = await this.act(() => window.workbench.writeFile(ui.root, filePath, content));
      if (!status) return false;
      this.update(status);
      this.editor?.reloadClean(filePath);
      this.message(`${filePath} enregistré.`);
      return true;
    });
  },
  async renderDiff(filePath, data, title, actions, onSave) {
    const { showDiff } = await views();
    this.setView('diff', title);
    showDiff($('#diff-view'), $('#view-tools'), { path: filePath, data, actions, onSave });
  },
  async copy(text, label) {
    try { await navigator.clipboard.writeText(text); this.message(`${label} : ${text}.`); }
    catch { this.message('Copie impossible dans le presse-papiers.'); }
  },
  async createBranch(startPoint = null) {
    const name = await askText({
      title: startPoint ? 'Créer une branche ici' : 'Nouvelle branche',
      label: 'NOM DE LA BRANCHE',
      confirmLabel: 'Créer',
      hint: startPoint ? `La branche pointera sur ${startPoint.slice(0, 7)} ; la branche courante ne change pas.` : `Créée depuis le HEAD de « ${this.branch} », puis la branche courante.`,
    });
    if (!name) return;
    if (await this.act(() => window.workbench.createBranch(ui.root, name, startPoint))) { await this.reload(); this.message(`Branche « ${name} » créée.`); }
  },
  async cherryPick(hash) {
    const result = await this.act(() => window.workbench.cherryPick(ui.root, hash));
    if (result) { await this.reload(); this.message(`Cherry-pick terminé. Récupération conservée : ${result.recoveryRef}.`); }
  },
  async rebase(onto) {
    const result = await this.act(() => window.workbench.rebase(ui.root, onto));
    if (result) { await this.reload(); this.message(`Rebase terminé. Récupération conservée : ${result.recoveryRef}.`); }
  },
  async interactiveRebase(onto, label) {
    const data = await this.act(() => window.workbench.interactiveRebaseCommits(ui.root, onto));
    if (!data) return;
    if (!data.commits.length) { this.message(`Aucun commit de « ${this.branch} » à réorganiser au-dessus de ${label}.`); return; }
    const plan = await editRebasePlan({ base: label, branch: this.branch, commits: data.commits });
    if (!plan) return;
    const result = await this.act(() => window.workbench.interactiveRebase(ui.root, onto, plan));
    if (result) { await this.reload(); this.message(`Rebase interactif terminé. Récupération conservée : ${result.recoveryRef}.`); }
  },
  // Les commits entrants s'affichent avant tout changement ; un refus (conflit compris) recharge la vue pour montrer
  // l'opération en cours.
  async merge(source, label = source) {
    const preview = await this.act(() => window.workbench.mergePreview(ui.root, source));
    if (!preview) return;
    if (!preview.total) { this.message(`« ${this.branch} » contient déjà tous les commits de « ${label} ».`); return; }
    const choice = await confirmMerge({ source: label, branch: this.branch, preview });
    if (!choice) return;
    const result = await this.act(() => window.workbench.merge(ui.root, source, preview.target, choice.fastForward));
    await this.reload();
    if (result) this.message(`${result.fastForwarded ? 'Fast-forward' : 'Merge'} de « ${label} » terminé. Récupération conservée : ${result.recoveryRef}.`);
  },
  async pull() {
    if (!this.upstream) return;
    $('#pull-button').disabled = true;
    this.message(`Pull depuis ${this.upstream}…`);
    const result = await this.act(() => window.workbench.pull(ui.root, this.upstream));
    await this.reload();
    if (!result) return;
    if (result.pulled) { this.message(`Pull terminé : ${result.behind} commit(s) intégré(s) en fast-forward. Récupération conservée : ${result.recoveryRef}.`); return; }
    if (!result.diverged) { this.message(`« ${this.branch} » est à jour avec ${result.upstream}${result.ahead ? ` (${result.ahead} commit(s) à pousser)` : ''}.`); return; }
    const choice = await chooseIntegration({ branch: this.branch, ...result });
    if (choice === 'merge') await this.merge(result.upstream);
    else if (choice === 'rebase') await this.rebase(result.upstream);
  },
  async push() {
    const result = await this.act(() => window.workbench.push(ui.root, this.upstream));
    if (result) { await this.reload(); this.message(`Push vérifié vers ${result.upstream} (${result.hash.slice(0, 12)}).`); }
  },
  commitMenu(commit, x, y) {
    const short = commit.hash.slice(0, 7);
    this.selectCommit(commit.hash);
    showMenu([
      ['Créer une branche ici…', () => this.createBranch(commit.hash)],
      ['Cherry-pick ce commit', () => this.cherryPick(commit.hash)],
      [`Merger ${short} dans « ${this.branch} »…`, () => this.merge(commit.hash, short)],
      [`Rebaser « ${this.branch} » sur ${short}`, () => this.rebase(commit.hash)],
      [`Rebase interactif de « ${this.branch} » depuis ${short}…`, () => this.interactiveRebase(commit.hash, short)],
      null,
      ['Copier le SHA', () => this.copy(commit.hash, 'SHA copié')],
      ['Copier le message', () => this.copy(commit.summary ? `${commit.subject}\n\n${commit.summary}` : commit.subject, 'Message copié')],
    ], x, y);
  },
  refMenu(kind, ref, x, y) {
    const isCurrent = kind === 'local' && ref.name === this.branch;
    const items = [];
    if (kind === 'local' && !isCurrent) items.push([`Basculer sur « ${ref.name} »`, () => this.checkout(ref.name)]);
    if (kind === 'remote') {
      const remote = this.findRef('remote', ref.name) || ref;
      if (remote.trackedBy) items.push([`Basculer sur « ${remote.trackedBy} » (qui la suit)`, () => this.checkout(remote.trackedBy), remote.trackedBy === this.branch]);
      else items.push([`Créer « ${remote.branch || ref.name} » en local et basculer`, () => this.checkoutRemote(ref.name)]);
    }
    if (isCurrent) items.push([this.upstream ? `Pull depuis ${this.upstream}` : 'Pull (upstream non configuré)', () => this.pull(), !this.upstream]);
    if (isCurrent) items.push([this.upstream ? `Push vers ${this.upstream}` : 'Push (upstream non configuré)', () => this.push(), !this.upstream]);
    if (!isCurrent) items.push([`Merger « ${ref.name} » dans « ${this.branch} »…`, () => this.merge(ref.name)]);
    if (kind !== 'tags' && !isCurrent) {
      items.push([`Rebaser « ${this.branch} » sur « ${ref.name} »`, () => this.rebase(ref.name)]);
      items.push([`Rebase interactif de « ${this.branch} » sur « ${ref.name} »…`, () => this.interactiveRebase(ref.name, ref.name)]);
    }
    if (ref.hash) items.push(['Créer une branche ici…', () => this.createBranch(ref.hash)]);
    // Page de la branche sur GitHub/GitLab : distante elle-même, ou upstream d'une branche locale.
    const remoteRef = kind === 'remote' ? this.findRef('remote', ref.name) : kind === 'local' && ref.upstream ? this.findRef('remote', ref.upstream) : null;
    const site = remoteRef && (this.refs.remotes || []).find((item) => item.name === remoteRef.remote && item.web);
    if (site) items.push([`Ouvrir la branche sur ${site.host}`, () => this.invoke(() => window.workbench.openRemote(ui.root, site.name, remoteRef.branch))]);
    items.push(null, ['Copier le nom', () => this.copy(ref.name, 'Nom copié')]);
    showMenu(items, x, y);
  },
};

const chooseRepository = async () => ui.open(await ui.invoke(() => window.workbench.chooseRepository()));
$('#open-repo').addEventListener('click', chooseRepository);
$('#empty-open').addEventListener('click', chooseRepository);
$('#new-tab').addEventListener('click', chooseRepository);
// Menu de l'application (remplace la barre de menu native) et ses raccourcis.
const windowAction = (action) => ui.invoke(() => window.workbench.windowAction(action));
// Une version plus récente trouvée (au démarrage ou depuis la fenêtre) est signalée par une pastille sur le menu.
const setUpdate = (found) => {
  ui.update = found?.available ? found : null;
  $('#app-menu').classList.toggle('has-update', Boolean(ui.update));
};
const appMenu = () => {
  const box = $('#app-menu').getBoundingClientRect();
  showMenu([
    ['Ouvrir un dépôt…', chooseRepository, false, 'Ctrl+O'],
    ['Fermer l’onglet', () => ui.closeTab(ui.root), !ui.opened],
    null,
    ['Graphe', () => ui.showGraph(), !ui.opened],
    ['Éditeur', () => ui.showEditor(), !ui.opened, 'Ctrl+P'],
    null,
    ['Zoom avant', () => windowAction('zoom-in'), false, 'Ctrl+='],
    ['Zoom arrière', () => windowAction('zoom-out'), false, 'Ctrl+-'],
    ['Taille normale', () => windowAction('zoom-reset'), false, 'Ctrl+0'],
    ['Plein écran', () => windowAction('fullscreen'), false, 'F11'],
    null,
    [ui.update ? `Mise à jour disponible (${ui.update.latest.version})…` : 'Mises à jour…', () => openUpdates({ check: Boolean(ui.update), onResult: setUpdate })],
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
  if (ui.update) ui.message(`Git Workbench ${ui.update.latest.version} est disponible : menu ☰ › Mise à jour disponible.`);
});
$('#refresh').addEventListener('click', () => ui.reload());
$('#fetch-button').addEventListener('click', () => ui.fetch());
$('#view-graph').addEventListener('click', () => ui.showGraph());
$('#view-editor').addEventListener('click', () => ui.showEditor());
$('#folder-button').addEventListener('click', (event) => { event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); ui.folderMenu(box.left, box.bottom + 4); });
$('#amend-toggle').addEventListener('change', (event) => ui.setAmend(event.target.checked));
$('#conventional-button').addEventListener('click', () => ui.conventional());
// Ctrl+P : ouverture rapide d'un fichier dans l'éditeur, depuis n'importe quelle vue.
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p' && ui.opened && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    ui.showEditor().then(() => ui.editor?.focusSearch());
  }
});
$('#push-button').addEventListener('click', () => ui.push());
$('#pull-button').addEventListener('click', () => ui.pull());
$('#new-branch').addEventListener('click', () => ui.createBranch());
$('#back-to-graph').addEventListener('click', () => ui.showGraph());
$('#ref-filter').addEventListener('input', () => ui.renderRefs());
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && ui.view === 'diff' && !document.querySelector('dialog[open]')) ui.showGraph(); });
$('#commit-summary').addEventListener('input', () => ui.updateComposer());
$('#commit-summary').addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !$('#commit-button').disabled) $('#commit-button').click(); });
$('#commit-button').addEventListener('click', async () => {
  const summary = $('#commit-summary').value.trim();
  const description = $('#commit-description').value.trim();
  if (!summary) { ui.message('Un résumé de commit non vide est requis.'); return; }
  const message = description ? `${summary}\n\n${description}` : summary;
  if (ui.amend) {
    const result = await ui.act(() => window.workbench.amend(ui.root, message));
    if (!result) return;
    ui.amend = null;
    $('#amend-toggle').checked = false;
    $('#commit-summary').value = ''; $('#commit-description').value = '';
    await ui.reload();
    ui.message(`Dernier commit amendé : ${result.hash.slice(0, 12)}. Ancienne version conservée : ${result.recoveryRef}.`);
    return;
  }
  const hash = await ui.act(() => window.workbench.commit(ui.root, message));
  if (hash) {
    $('#commit-summary').value = ''; $('#commit-description').value = '';
    await ui.reload();
    ui.message(`Commit local créé : ${hash.slice(0, 12)}.`);
  }
});

window.workbench.onConfirmRequest(confirmDialog);
