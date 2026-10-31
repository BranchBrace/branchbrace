import { WIP, renderGraph } from './graph-view.js';
import { renderCommitDetails, renderWorkingChanges } from './details-view.js';
import { renderRefs } from './refs-view.js';
import { alertDialog, askText, confirmDialog, editRebasePlan, showMenu } from './dialogs.js';
import { describeError } from './errors.js';

const SUMMARY_LIMIT = 72;
const $ = (selector) => document.querySelector(selector);

const repositoryName = (root) => root.split(/[\\/]/).filter(Boolean).pop() || root;

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
  async invoke(action) {
    try { return await action(); }
    catch (error) { this.message(describeError(error)); return null; }
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
  message(text) { $('#status-message').textContent = text; },
  // Affiche un dépôt (instantané renvoyé par le processus principal) dans son onglet, en gardant le brouillon de
  // commit de l'onglet quitté.
  open(data, message = 'Dépôt ouvert en lecture locale. Aucun contenu n’a été transmis.') {
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
    for (const id of ['#new-branch', '#refresh']) $(id).disabled = false;
    this.selected = null;
    this.selectedCommit = WIP;
    this.details = null;
    this.update(data.status, data.graph, data.refs);
    this.showGraph();
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
    for (const id of ['#new-branch', '#refresh', '#push-button']) $(id).disabled = true;
    $('#graph-panel').hidden = true;
    $('#diff-view').hidden = true;
    $('#workspace-header').hidden = true;
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
    if (graph) this.graph = graph;
    if (refs) this.refs = refs;
    $('#branch-name').textContent = status.branch;
    $('#push-button').disabled = !status.upstream;
    $('#push-button').title = status.upstream ? `Pousser vers ${status.upstream}` : 'Upstream non configuré';
    if (this.selectedCommit !== WIP && !this.graph.commits.some((commit) => commit.hash === this.selectedCommit)) { this.selectedCommit = WIP; this.details = null; }
    this.renderGraph();
    this.renderRefs();
    this.renderPanel();
  },
  showGraph() {
    $('#graph-panel').hidden = false;
    $('#diff-view').hidden = true;
    $('#workspace-header').hidden = true;
  },
  showDiffPane(title) {
    $('#graph-panel').hidden = true;
    $('#diff-view').hidden = false;
    $('#workspace-header').hidden = false;
    $('#view-title').textContent = title;
  },
  renderGraph() {
    renderGraph($('#graph-rows'), { ...this.graph, wip: this.files.length, selected: this.selectedCommit }, {
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
      onContextMenu: (kind, ref, x, y) => this.refMenu(kind, ref, x, y),
    });
  },
  findRef(kind, name) { return this.refs[kind]?.find((ref) => ref.name === name); },
  revealCommit(hash) {
    const row = document.querySelector(`.graph-row[data-hash="${hash}"]`);
    if (!row) { this.message('Ce commit est au-delà des 500 derniers affichés dans le graphe.'); return; }
    this.showGraph();
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
        onOpenFile: (file) => this.showCommitDiff(this.details.hash, file.path),
        onFileMenu: (file, x, y) => showMenu([
          ['Voir le diff', () => this.showCommitDiff(this.details.hash, file.path)],
          ['Copier le chemin', () => this.copy(file.path, 'Chemin copié')],
        ], x, y),
        onSelectParent: (parent) => this.revealCommit(parent),
      });
      return;
    }
    renderWorkingChanges(panel, this.files, {
      branch: this.branch,
      selectedFile: this.selected,
      onOpenFile: (file, staged) => this.showDiff(file.path, staged),
      onToggleStage: (file) => this.toggleStage(file),
      onStageAll: () => this.applyStatus(() => window.workbench.stageAll(ui.root)),
      onUnstageAll: () => this.applyStatus(() => window.workbench.unstageAll(ui.root)),
      onFileMenu: (file, staged, x, y) => showMenu([
        [staged ? 'Retirer de l’index' : 'Ajouter à l’index', () => this.toggleStage(file)],
        ['Voir le diff', () => this.showDiff(file.path, staged)],
        null,
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
    button.disabled = !staged || !summary.trim();
    button.textContent = !staged ? 'Indexez des changements pour committer' : !summary.trim() ? 'Saisissez un résumé' : `Committer ${staged} fichier${staged > 1 ? 's' : ''}`;
  },
  async applyStatus(action) {
    const status = await this.act(action);
    if (status) this.update(status);
    return status;
  },
  async toggleStage(file) {
    if (await this.applyStatus(() => file.staged ? window.workbench.unstage(ui.root, file.path) : window.workbench.stage(ui.root, file.path)) && this.selected === file.path) await this.showDiff(file.path);
  },
  async checkout(branch) {
    if (await this.act(() => window.workbench.switchBranch(ui.root, branch))) { await this.reload(); this.message(`Branche courante : ${branch}.`); }
  },
  async showCommitDiff(hash, filePath) {
    const result = await this.invoke(() => window.workbench.commitFileDiff(ui.root, hash, filePath));
    if (result === null) return;
    this.detailFile = filePath;
    this.renderPanel();
    this.renderDiff(result, `${filePath} · ${hash.slice(0, 7)}`);
  },
  async showDiff(filePath, staged = this.files.find((file) => file.path === filePath)?.staged === true) {
    const result = await this.invoke(() => window.workbench.diff(ui.root, filePath, staged));
    if (result === null) return;
    this.selected = filePath;
    this.renderPanel();
    this.renderDiff(result, `${filePath} · ${staged ? 'indexé' : 'non indexé'}`);
  },
  renderDiff(result, title) {
    this.showDiffPane(title);
    const pane = $('#diff-view'); pane.replaceChildren();
    if (!result) { pane.textContent = 'Aucun diff disponible pour cette sélection.'; return; }
    for (const line of result.split('\n')) {
      const row = document.createElement('div');
      row.textContent = line;
      if (line.startsWith('+') && !line.startsWith('+++')) row.className = 'diff-add';
      if (line.startsWith('-') && !line.startsWith('---')) row.className = 'diff-del';
      if (line.startsWith('@@')) row.className = 'diff-hunk';
      pane.append(row);
    }
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
    if (isCurrent) items.push([this.upstream ? `Push vers ${this.upstream}` : 'Push (upstream non configuré)', () => this.push(), !this.upstream]);
    if (kind !== 'tags' && !isCurrent) {
      items.push([`Rebaser « ${this.branch} » sur « ${ref.name} »`, () => this.rebase(ref.name)]);
      items.push([`Rebase interactif de « ${this.branch} » sur « ${ref.name} »…`, () => this.interactiveRebase(ref.name, ref.name)]);
    }
    if (ref.hash) items.push(['Créer une branche ici…', () => this.createBranch(ref.hash)]);
    items.push(null, ['Copier le nom', () => this.copy(ref.name, 'Nom copié')]);
    showMenu(items, x, y);
  },
};

const chooseRepository = async () => ui.open(await ui.invoke(() => window.workbench.chooseRepository()));
$('#open-repo').addEventListener('click', chooseRepository);
$('#empty-open').addEventListener('click', chooseRepository);
$('#new-tab').addEventListener('click', chooseRepository);

// Au lancement : rouvre les onglets de la session précédente et l'onglet qui était actif.
(async () => {
  const session = await ui.invoke(() => window.workbench.restoreSession());
  if (!session?.snapshot) return;
  ui.tabs = session.tabs;
  ui.open(session.snapshot, `Session restaurée : ${session.tabs.length} dépôt${session.tabs.length > 1 ? 's' : ''}.`);
})();
$('#refresh').addEventListener('click', () => ui.reload());
$('#push-button').addEventListener('click', () => ui.push());
$('#new-branch').addEventListener('click', () => ui.createBranch());
$('#back-to-graph').addEventListener('click', () => ui.showGraph());
$('#ref-filter').addEventListener('input', () => ui.renderRefs());
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#diff-view').hidden && !document.querySelector('dialog[open]')) ui.showGraph(); });
$('#commit-summary').addEventListener('input', () => ui.updateComposer());
$('#commit-button').addEventListener('click', async () => {
  const summary = $('#commit-summary').value.trim();
  const description = $('#commit-description').value.trim();
  if (!summary) { ui.message('Un résumé de commit non vide est requis.'); return; }
  const hash = await ui.act(() => window.workbench.commit(ui.root, description ? `${summary}\n\n${description}` : summary));
  if (hash) {
    $('#commit-summary').value = ''; $('#commit-description').value = '';
    await ui.reload();
    ui.message(`Commit local créé : ${hash.slice(0, 12)}.`);
  }
});

window.workbench.onConfirmRequest(confirmDialog);
