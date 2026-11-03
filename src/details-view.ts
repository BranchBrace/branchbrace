import type { CommitDetails, CommitFile, StatusEntry } from './git.ts';
import { relativeDate } from './graph-view.ts';

export interface CommitDetailsHandlers {
  selectedFile: string | null;
  onClose: () => unknown;
  onReview: () => unknown;
  onOpenFile: (file: CommitFile) => unknown;
  onFileMenu: (file: CommitFile, x: number, y: number) => unknown;
  onSelectParent: (parent: string) => unknown;
}
export interface WorkingChangesHandlers {
  branch: string;
  selectedFile: string | null;
  onOpenFile: (file: StatusEntry, staged: boolean) => unknown;
  onResolve: (file: StatusEntry) => unknown;
  onToggleStage: (file: StatusEntry) => unknown;
  onStageAll: () => unknown;
  onUnstageAll: () => unknown;
  onFileMenu: (file: StatusEntry, staged: boolean, x: number, y: number) => unknown;
}

// Ce qu'une ligne de fichier affiche : statut à une lettre, chemins et, pour un commit, lignes ajoutées/supprimées.
interface RowFile {
  path: string;
  originalPath: string | null;
  status: string;
  binary?: boolean;
  additions?: number;
  deletions?: number;
}
interface RowOptions<F> {
  selected: boolean;
  onOpen: (file: F) => unknown;
  onMenu?: (x: number, y: number) => unknown;
  action?: HTMLElement;
  nested?: boolean;
}

// Panneau de droite : ce qu'un commit (ou le WIP) modifie, lisible d'un coup d'œil.
const STATUS: Record<string, [string, string, string]> = {
  A: ['Ajouté', 'ajouté', 'ajoutés'],
  M: ['Modifié', 'modifié', 'modifiés'],
  D: ['Supprimé', 'supprimé', 'supprimés'],
  R: ['Renommé', 'renommé', 'renommés'],
  C: ['Copié', 'copié', 'copiés'],
  T: ['Type changé', 'type changé', 'types changés'],
  U: ['En conflit', 'en conflit', 'en conflit'],
  '?': ['Non suivi', 'non suivi', 'non suivis'],
};
const BLOCKS = 5;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? 's' : ''}`;

function header(label: Node, onClose: () => unknown) {
  const row = element('div', 'details-header');
  row.append(label);
  const close = element('button', 'icon-button small', '×'); close.setAttribute('aria-label', 'Fermer le détail');
  close.addEventListener('click', onClose);
  row.append(close);
  return row;
}

// Barre de résumé : nombre de fichiers, lignes ajoutées/supprimées et répartition par type de changement.
function summary(files: readonly RowFile[], withStats: boolean) {
  const box = element('div', 'change-summary');
  const top = element('div', 'summary-top');
  top.append(element('strong', '', plural(files.length, 'fichier')));
  if (withStats) {
    const additions = files.reduce((sum, file) => sum + (file.additions || 0), 0);
    const deletions = files.reduce((sum, file) => sum + (file.deletions || 0), 0);
    const counts = element('span', 'summary-lines');
    counts.append(element('span', 'plus', `+${additions}`), ' ', element('span', 'minus', `−${deletions}`));
    top.append(counts);
    const bar = element('div', 'summary-bar');
    const total = additions + deletions;
    const plus = element('span', 'plus'); plus.style.flexGrow = String(total ? additions : 0);
    const minus = element('span', 'minus'); minus.style.flexGrow = String(total ? deletions : 0);
    bar.append(plus, minus);
    box.append(top, bar);
  } else box.append(top);
  const kinds = element('div', 'summary-kinds');
  const byStatus = new Map<string, number>();
  for (const file of files) byStatus.set(file.status, (byStatus.get(file.status) || 0) + 1);
  for (const [status, count] of byStatus) {
    const [, one, many] = STATUS[status] || [status, status, status];
    kinds.append(element('span', `kind change-${status}`, `${count} ${count > 1 ? many : one}`));
  }
  box.append(kinds);
  return box;
}

// Pictogrammes de statut façon GitKraken : un trait coloré par type de changement, sans pastille.
const ICONS: Record<string, string> = {
  A: '<path d="M8 3v10M3 8h10"/>',
  M: '<path d="M3 13l.9-3.4L10.4 3.1a1.4 1.4 0 0 1 2 0l.5.5a1.4 1.4 0 0 1 0 2L6.4 12.1z"/>',
  D: '<path d="M3 8h10"/>',
  R: '<path d="M3 8h9.5M9 4.5 12.5 8 9 11.5"/>',
  C: '<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.2"/><path d="M3 10.5V4a1 1 0 0 1 1-1h6.5"/>',
  T: '<path d="M3.5 3.5h9M8 3.5v9"/>',
  U: '<path d="M8 2.5 14 13H2z"/><path d="M8 6.5v2.8M8 11.2v.1"/>',
};
ICONS['?'] = ICONS.A;

function statusIcon(status: string) {
  const icon = element('span', `change-icon change-${status}`);
  icon.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[status] || ICONS.M}</svg>`;
  icon.title = STATUS[status]?.[0] || status;
  return icon;
}

// Une ligne par fichier : pictogramme, dossier en retrait puis nom, tronqués par la gauche pour garder le nom lisible.
function fileRow<F extends RowFile>(file: F, { selected, onOpen, onMenu, action, nested = false }: RowOptions<F>) {
  const row = element('div', `details-file${selected ? ' selected' : ''}${nested ? ' nested' : ''}`);
  row.tabIndex = 0;
  row.dataset.path = file.path;
  row.title = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
  const slash = file.path.lastIndexOf('/');
  const names = element('span', 'file-names');
  const dir = nested ? '' : file.path.slice(0, slash + 1);
  const folder = file.originalPath ? `${file.originalPath} → ${dir}` : dir;
  if (folder) {
    const path = element('span', 'file-folder');
    path.append(element('bdi', '', folder));
    names.append(path);
  }
  names.append(element('span', 'file-name', file.path.slice(slash + 1)));
  row.append(statusIcon(file.status), names);
  if (file.binary) row.append(element('span', 'file-stat muted', 'binaire'));
  else if (file.additions !== undefined) {
    const stat = element('span', 'file-stat');
    stat.append(element('span', 'plus', file.additions ? `+${file.additions}` : ''), element('span', 'minus', file.deletions ? `−${file.deletions}` : ''));
    const blocks = element('span', 'blocks');
    const total = file.additions + (file.deletions ?? 0);
    const green = total ? Math.round((file.additions / total) * BLOCKS) : 0;
    for (let i = 0; i < BLOCKS; i += 1) blocks.append(element('i', total === 0 ? '' : i < green ? 'plus' : 'minus'));
    stat.append(blocks);
    row.append(stat);
  }
  if (action) row.append(action);
  const open = () => onOpen(file);
  row.addEventListener('click', open);
  row.addEventListener('keydown', (event) => { if (event.key === 'Enter') open(); });
  if (onMenu) row.addEventListener('contextmenu', (event) => { event.preventDefault(); onMenu(event.clientX, event.clientY); });
  return row;
}

// Le panneau est reconstruit à chaque clic : chaque liste repérée par sa clé garde son défilement, et la ligne
// qui avait le focus clavier le retrouve, au lieu de tout remonter en haut.
function replacePanel(panel: HTMLElement, nodes: readonly Node[]) {
  const keyOf = (node: Element) => node.closest<HTMLElement>('[data-scroll-key]')?.dataset.scrollKey;
  const scrolls = new Map([...panel.querySelectorAll<HTMLElement>('[data-scroll-key]')].map((list) => [list.dataset.scrollKey, list.scrollTop]));
  const active = document.activeElement?.closest?.<HTMLElement>('.details-file');
  const focused = active && panel.contains(active) ? { key: keyOf(active), path: active.dataset.path } : null;
  panel.replaceChildren(...nodes);
  panel.hidden = false;
  for (const list of panel.querySelectorAll<HTMLElement>('[data-scroll-key]')) list.scrollTop = scrolls.get(list.dataset.scrollKey) || 0;
  if (focused) {
    const row = [...panel.querySelectorAll<HTMLElement>('.details-file')].find((node) => node.dataset.path === focused.path && keyOf(node) === focused.key);
    row?.focus({ preventScroll: true });
  }
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('') || '?';
const hue = (text: string) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);

// Liste à plat (chemin complet) ou arborescence (fichiers regroupés par dossier), au choix, mémorisé.
const LAYOUT_KEY = 'branchbrace.files-layout';
let layout: 'list' | 'tree' = (() => { try { return localStorage.getItem(LAYOUT_KEY) === 'tree' ? 'tree' : 'list'; } catch { return 'list'; } })();

function fileList<F extends RowFile>(files: readonly F[], options: (file: F) => RowOptions<F>) {
  const box = element('div', 'details-files');
  if (layout === 'list') {
    for (const file of files) box.append(fileRow(file, options(file)));
    return box;
  }
  const folders = new Map<string, F[]>();
  for (const file of files) {
    const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder)!.push(file);
  }
  for (const folder of [...folders.keys()].sort((a, b) => a.localeCompare(b))) {
    const head = element('div', 'files-folder');
    head.append(element('span', 'files-folder-icon', '▾'), element('span', '', folder ? `${folder}/` : 'racine du dépôt'), element('span', 'files-folder-count', String(folders.get(folder)!.length)));
    box.append(head);
    for (const file of folders.get(folder)!) box.append(fileRow(file, { ...options(file), nested: true }));
  }
  return box;
}

export function renderCommitDetails(panel: HTMLElement, details: CommitDetails, { selectedFile, onClose, onReview, onOpenFile, onFileMenu, onSelectParent }: CommitDetailsHandlers): void {
  const [subject, ...body] = details.message.split('\n');
  const sha = element('code', 'sha-chip', details.hash.slice(0, 7)); sha.title = details.hash;
  const title = element('h2', 'details-subject', subject);
  const description = element('p', 'details-body', body.join('\n').trim()); description.hidden = !description.textContent;
  const author = element('div', 'details-author');
  const avatar = element('span', 'details-avatar', initials(details.author));
  avatar.style.setProperty('--hue', String(hue(details.author)));
  const who = element('div', 'details-who');
  const date = new Date(details.authorDate);
  const when = element('span', 'details-when', `${relativeDate(date.getTime() / 1000)} · ${date.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })}`);
  who.append(element('strong', '', details.author), when);
  if (details.committer !== details.author) who.append(element('span', 'details-when', `Committé par ${details.committer}`));
  author.append(avatar, who);
  const parents = element('div', 'details-parents', details.parents.length > 1 ? 'Parents : ' : 'Parent : ');
  for (const parent of details.parents) {
    const link = element('button', 'link', parent.slice(0, 7));
    link.addEventListener('click', () => onSelectParent(parent));
    parents.append(link, ' ');
  }
  if (details.parents.length > 1) parents.append(element('span', 'muted', '· changements comparés au premier parent'));
  const review = element('button', 'button primary review-button', `Voir les changements (${plural(details.files.length, 'fichier')})`);
  review.title = 'Tous les fichiers modifiés et leurs diffs, l’un sous l’autre';
  review.disabled = !details.files.length;
  review.addEventListener('click', onReview);
  const filesHead = element('div', 'files-head');
  const switcher = element('span', 'segmented');
  for (const [mode, label, hint] of [['list', 'Liste', 'Chemins complets'], ['tree', 'Arbre', 'Regroupés par dossier']] as const) {
    const button = element('button', `chip-toggle${layout === mode ? ' active' : ''}`, label);
    button.title = hint;
    button.addEventListener('click', () => {
      layout = mode;
      try { localStorage.setItem(LAYOUT_KEY, mode); } catch { /* stockage indisponible */ }
      renderCommitDetails(panel, details, { selectedFile, onClose, onReview, onOpenFile, onFileMenu, onSelectParent });
    });
    switcher.append(button);
  }
  filesHead.append(element('span', 'eyebrow', 'FICHIERS'), switcher);
  const files = details.files.length
    ? fileList(details.files, (file) => ({ selected: file.path === selectedFile, onOpen: onOpenFile, onMenu: (x, y) => onFileMenu(file, x, y) }))
    : element('p', 'muted', 'Aucun fichier modifié.');
  files.dataset.scrollKey = `commit:${details.hash}`;
  replacePanel(panel, [header(sha, onClose), title, description, author, parents, review, summary(details.files, true), filesHead, files]);
}

// Statut à afficher pour un fichier du WIP : celui de l'index s'il est indexé, sinon celui de l'arbre de travail.
const workingStatus = (file: StatusEntry, staged: boolean) => (file.untracked ? '?' : (staged ? file.indexStatus : file.worktreeStatus).replace(' ', 'M'));

// Zone de staging façon GitKraken : non indexés puis indexés, chacun avec son action groupée.
export function renderWorkingChanges(panel: HTMLElement, files: readonly StatusEntry[], { branch, selectedFile, onOpenFile, onResolve, onToggleStage, onStageAll, onUnstageAll, onFileMenu }: WorkingChangesHandlers): void {
  const title = element('div', 'wip-title');
  title.append(element('strong', '', files.length ? `${plural(files.length, 'fichier')} modifié${files.length > 1 ? 's' : ''}` : 'Aucun changement'), ' sur ', element('span', 'branch-chip', branch));
  const nodes: HTMLElement[] = [title];
  if (!files.length) nodes.push(element('p', 'muted wip-clean', 'L’arbre de travail est propre : rien à indexer ni à committer.'));
  // Fichiers en conflit d'abord : ils bloquent l'opération en cours tant qu'ils ne sont pas résolus.
  const conflicts = files.filter((file) => file.conflicted);
  if (conflicts.length) {
    const head = element('div', 'stage-group-header conflict-header');
    head.append(element('span', '', `En conflit (${conflicts.length})`));
    const list = element('div', 'details-files stage-list conflict-list');
    list.dataset.scrollKey = 'conflicts';
    list.style.setProperty('--rows', String(Math.min(conflicts.length, 3)));
    for (const file of conflicts) {
      const resolve = element('button', 'button compact resolve-button', 'Résoudre');
      resolve.title = 'Ouvrir l’outil de fusion';
      resolve.addEventListener('click', (event) => { event.stopPropagation(); onResolve(file); });
      list.append(fileRow({ ...file, status: 'U' }, { selected: file.path === selectedFile, onOpen: () => onResolve(file), onMenu: (x, y) => onFileMenu(file, false, x, y), action: resolve }));
    }
    nodes.push(head, list);
  }
  const groups: [name: string, members: StatusEntry[], staged: boolean, bulkLabel: string, bulk: () => unknown][] = [

    ['Non indexés', files.filter((file) => file.unstaged), false, 'Tout indexer', onStageAll],
    ['Indexés', files.filter((file) => file.staged), true, 'Tout désindexer', onUnstageAll],
  ];
  if (files.length) {
    for (const [name, members, staged, bulkLabel, bulk] of groups) {
      const head = element('div', 'stage-group-header');
      head.append(element('span', '', `${name} (${members.length})`));
      const button = element('button', `button ${staged ? 'secondary' : 'stage-all'} compact`, bulkLabel);
      button.disabled = !members.length;
      button.addEventListener('click', bulk);
      head.append(button);
      const list = element('div', 'details-files stage-list');
      list.dataset.scrollKey = staged ? 'staged' : 'unstaged';
      list.style.setProperty('--rows', String(Math.min(members.length, 3)));
      for (const file of members) {
        const toggle = element('button', 'stage', staged ? '−' : '+');
        toggle.title = staged ? 'Retirer de l’index' : 'Ajouter à l’index';
        toggle.addEventListener('click', (event) => { event.stopPropagation(); onToggleStage(file); });
        list.append(fileRow({ ...file, status: workingStatus(file, staged) }, {
          selected: file.path === selectedFile, onOpen: () => onOpenFile(file, staged),
          onMenu: (x, y) => onFileMenu(file, staged, x, y), action: toggle,
        }));
      }
      if (!members.length) list.append(element('p', 'muted stage-empty', staged ? 'Rien d’indexé pour le prochain commit.' : 'Tout est indexé.'));
      nodes.push(head, list);
    }
  }
  replacePanel(panel, nodes);
}