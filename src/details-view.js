import { relativeDate } from './graph-view.js';

// Panneau de droite : ce qu'un commit (ou le WIP) modifie, lisible d'un coup d'œil.
const STATUS = {
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

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const plural = (count, word) => `${count} ${word}${count > 1 ? 's' : ''}`;

function header(label, onClose) {
  const row = element('div', 'details-header');
  row.append(label);
  const close = element('button', 'icon-button small', '×'); close.setAttribute('aria-label', 'Fermer le détail');
  close.addEventListener('click', onClose);
  row.append(close);
  return row;
}

// Barre de résumé : nombre de fichiers, lignes ajoutées/supprimées et répartition par type de changement.
function summary(files, withStats) {
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
  const byStatus = new Map();
  for (const file of files) byStatus.set(file.status, (byStatus.get(file.status) || 0) + 1);
  for (const [status, count] of byStatus) {
    const [, one, many] = STATUS[status] || [status, status, status];
    kinds.append(element('span', `kind change-${status}`, `${count} ${count > 1 ? many : one}`));
  }
  box.append(kinds);
  return box;
}

function fileRow(file, { selected, onOpen, onMenu, action, nested = false }) {
  const row = element('div', `details-file${selected ? ' selected' : ''}${nested ? ' nested' : ''}`);
  row.tabIndex = 0;
  row.title = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
  const badge = element('span', `change-badge change-${file.status}`, file.status === '?' ? '+' : file.status);
  badge.title = STATUS[file.status]?.[0] || file.status;
  const slash = file.path.lastIndexOf('/');
  const names = element('span', 'file-names');
  names.append(element('span', 'file-name', file.path.slice(slash + 1)));
  const folder = file.originalPath ? `${file.originalPath} →` : nested ? '' : file.path.slice(0, slash + 1);
  if (folder) names.append(element('span', 'file-folder', folder));
  row.append(badge, names);
  if (file.binary) row.append(element('span', 'file-stat muted', 'binaire'));
  else if (file.additions !== undefined) {
    const stat = element('span', 'file-stat');
    stat.append(element('span', 'plus', file.additions ? `+${file.additions}` : ''), element('span', 'minus', file.deletions ? `−${file.deletions}` : ''));
    const blocks = element('span', 'blocks');
    const total = file.additions + file.deletions;
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

const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('') || '?';
const hue = (text) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);

// Liste à plat (chemin complet) ou arborescence (fichiers regroupés par dossier), au choix, mémorisé.
const LAYOUT_KEY = 'git-workbench.files-layout';
let layout = (() => { try { return localStorage.getItem(LAYOUT_KEY) === 'tree' ? 'tree' : 'list'; } catch { return 'list'; } })();

function fileList(files, options) {
  const box = element('div', 'details-files');
  if (layout === 'list') {
    for (const file of files) box.append(fileRow(file, options(file)));
    return box;
  }
  const folders = new Map();
  for (const file of files) {
    const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push(file);
  }
  for (const folder of [...folders.keys()].sort((a, b) => a.localeCompare(b))) {
    const head = element('div', 'files-folder');
    head.append(element('span', 'files-folder-icon', '▾'), element('span', '', folder ? `${folder}/` : 'racine du dépôt'), element('span', 'files-folder-count', String(folders.get(folder).length)));
    box.append(head);
    for (const file of folders.get(folder)) box.append(fileRow(file, { ...options(file), nested: true }));
  }
  return box;
}

export function renderCommitDetails(panel, details, { selectedFile, onClose, onReview, onOpenFile, onFileMenu, onSelectParent }) {
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
  for (const [mode, label, hint] of [['list', 'Liste', 'Chemins complets'], ['tree', 'Arbre', 'Regroupés par dossier']]) {
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
  panel.replaceChildren(header(sha, onClose), title, description, author, parents, review, summary(details.files, true), filesHead, files);
  panel.hidden = false;
}

// Statut à afficher pour un fichier du WIP : celui de l'index s'il est indexé, sinon celui de l'arbre de travail.
const workingStatus = (file, staged) => (file.untracked ? '?' : (staged ? file.indexStatus : file.worktreeStatus).replace(' ', 'M'));

// Zone de staging façon GitKraken : non indexés puis indexés, chacun avec son action groupée.
export function renderWorkingChanges(panel, files, { branch, selectedFile, onOpenFile, onResolve, onToggleStage, onStageAll, onUnstageAll, onFileMenu }) {
  const title = element('div', 'wip-title');
  title.append(element('strong', '', files.length ? `${plural(files.length, 'fichier')} modifié${files.length > 1 ? 's' : ''}` : 'Aucun changement'), ' sur ', element('span', 'branch-chip', branch));
  const nodes = [title];
  if (!files.length) nodes.push(element('p', 'muted wip-clean', 'L’arbre de travail est propre : rien à indexer ni à committer.'));
  // Fichiers en conflit d'abord : ils bloquent l'opération en cours tant qu'ils ne sont pas résolus.
  const conflicts = files.filter((file) => file.conflicted);
  if (conflicts.length) {
    const head = element('div', 'stage-group-header conflict-header');
    head.append(element('span', '', `En conflit (${conflicts.length})`));
    const list = element('div', 'details-files stage-list conflict-list');
    for (const file of conflicts) {
      const resolve = element('button', 'button compact resolve-button', 'Résoudre');
      resolve.title = 'Ouvrir l’outil de fusion';
      resolve.addEventListener('click', (event) => { event.stopPropagation(); onResolve(file); });
      list.append(fileRow({ ...file, status: 'U' }, { selected: file.path === selectedFile, onOpen: () => onResolve(file), onMenu: (x, y) => onFileMenu(file, false, x, y), action: resolve }));
    }
    nodes.push(head, list);
  }
  const groups = [
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
  panel.replaceChildren(...nodes);
  panel.hidden = false;
}