// Panneau de gauche façon GitKraken : sections LOCAL / DISTANT / TAGS repliables et filtrables. Chaque branche locale
// dit où elle en est par rapport à sa distante (à jour, en avance/retard, jamais poussée, distante supprimée) ; les
// branches distantes sont regroupées par dépôt (GitHub, GitLab…) et signalent celles qui n'existent pas en local.
// La section WORKTREES liste les dossiers de travail du dépôt (`git worktree list`).
import { refIcon } from './ref-icons.js';

const collapsed = new Set();
const PROVIDERS = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' };
// Logos des hébergeurs connus, dessinés ici : aucune requête réseau pour eux. Les autres hôtes montrent leur favicon.
const LOGOS = {
  github: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>',
  gitlab: '<svg viewBox="0 0 16 16"><path fill="#e24329" d="M8 15 5.2 6.5h5.6zM5.2 6.5 3.4 1 1.6 6.5zM10.8 6.5 12.6 1l1.8 5.5z"/><path fill="#fc6d26" d="M8 15 1.6 6.5h3.6zM8 15l6.4-8.5h-3.6z"/><path fill="#fca326" d="M1.6 6.5.6 9.3 8 15zM14.4 6.5l1 2.8L8 15z"/></svg>',
  bitbucket: '<svg viewBox="0 0 16 16"><path fill="#2684ff" fill-rule="evenodd" d="M1.2 1.5a.4.4 0 0 0-.4.46l1.9 11.6a.55.55 0 0 0 .54.46h9.3a.4.4 0 0 0 .4-.34l1.92-11.72a.4.4 0 0 0-.4-.46zm8.4 8.3H6.4l-.8-4.2h4.8z"/></svg>',
};
const favicons = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const folderName = (folder) => folder.split(/[\\/]/).filter(Boolean).pop() || folder;
const providerName =(remote) => PROVIDERS[remote?.provider] || remote?.host || 'distant';

// Logo de l'hébergeur d'un dépôt distant ; à défaut, le nuage « distant » jusqu'à l'arrivée de sa favicon (une
// demande par hôte, gardée en mémoire : les rendus suivants l'affichent avant de peindre).
function remoteLogo(remote, loadIcon) {
  const node = element('span', 'remote-logo');
  node.title = providerName(remote);
  if (LOGOS[remote.provider]) { node.innerHTML = LOGOS[remote.provider]; return node; }
  node.append(refIcon('remote', ''));
  if (!remote.host || !loadIcon) return node;
  if (!favicons.has(remote.host)) favicons.set(remote.host, Promise.resolve(loadIcon(remote.name)).catch(() => null));
  favicons.get(remote.host).then((src) => {
    if (!src) return;
    const image = element('img');
    image.alt = '';
    image.src = src;
    node.replaceChildren(image);
  });
  return node;
}

// Pastille d'état : couleur et pictogramme disent où vit la branche, le texte le confirme.
function pill(className, iconKind, text, title) {
  const node = element('span', `ref-pill ${className}`);
  if (iconKind) node.append(refIcon(iconKind, ''));
  node.append(text);
  node.title = title;
  return node;
}

function localPills(ref, refs) {
  if (ref.gone) return [pill('gone', 'local', 'distante supprimée', `${ref.upstream} n’existe plus sur le dépôt distant (supprimée après fusion ?)`)];
  if (!ref.upstream) return [pill('local-only', 'local', 'local seulement', 'Branche seulement sur cet ordinateur : jamais poussée, aucune distante associée')];
  const remote = refs.remote.find((item) => item.name === ref.upstream);
  const site = providerName((refs.remotes || []).find((item) => item.name === remote?.remote));
  if (!ref.ahead && !ref.behind) return [pill('synced', 'remote', 'à jour', `Identique à ${ref.upstream} (${site}) au dernier fetch`)];
  const pills = [];
  if (ref.ahead) pills.push(pill('ahead', null, `↑${ref.ahead} à pousser`, `${ref.ahead} commit(s) locaux pas encore sur ${ref.upstream} (${site})`));
  if (ref.behind) pills.push(pill('behind', null, `↓${ref.behind} à récupérer`, `${ref.behind} commit(s) de ${ref.upstream} (${site}) pas encore en local`));
  return pills;
}

function section(container, kind, title, icon, count, needle, build) {
  const node = element('section', `ref-section${collapsed.has(kind) && !needle ? ' collapsed' : ''}`);
  const header = element('button', 'ref-section-header');
  const glyph = element('span', 'ref-section-icon');
  glyph.append(icon);
  header.append(element('span', 'chevron', '›'), glyph, element('span', 'ref-section-title', title), element('span', 'ref-count', String(count)));
  header.addEventListener('click', () => { if (collapsed.has(kind)) collapsed.delete(kind); else collapsed.add(kind); node.classList.toggle('collapsed'); });
  const list = element('div', 'ref-list');
  build(list);
  if (!list.children.length) list.append(element('p', 'ref-empty', needle ? 'Aucun résultat.' : 'Aucune.'));
  node.append(header, list);
  container.append(node);
}

function row(kind, ref, label, { selectedHash, onSelect, onContextMenu }) {
  const item = element('div', `ref-item${ref.current ? ' current' : ''}${ref.hash === selectedHash ? ' selected' : ''}`);
  item.tabIndex = 0;
  item.append(element('span', 'ref-marker', ref.current ? '✓' : ''), element('span', 'ref-name', label));
  item.addEventListener('click', () => onSelect(ref.hash));
  item.addEventListener('keydown', (event) => { if (event.key === 'Enter') onSelect(ref.hash); });
  item.addEventListener('contextmenu', (event) => { event.preventDefault(); onContextMenu(kind, ref, event.clientX, event.clientY); });
  return item;
}

export function renderRefs(container, refs, handlers) {
  const { filter, onActivate, onCheckoutRemote, onOpenRemote, onRemoteMenu, onOpenWorktree, onWorktreeMenu, loadRemoteIcon } = handlers;
  const needle = filter.trim().toLowerCase();
  const matches = (name) => !needle || name.toLowerCase().includes(needle);
  container.replaceChildren();

  // Vue d'ensemble : ce qui n'est que local, ce qui n'est que distant.
  const unpublished = refs.local.filter((ref) => !ref.upstream || ref.gone).length;
  const toPush = refs.local.filter((ref) => ref.ahead).length;
  const remoteOnly = refs.remote.filter((ref) => !ref.trackedBy).length;
  const overview = element('div', 'ref-overview');
  const stat = (value, label, className, iconKind, title) => {
    const node = element('span', `overview-stat ${className}`);
    if (iconKind) node.append(refIcon(iconKind, ''));
    node.append(element('strong', '', String(value)), ` ${label}`);
    node.title = title;
    return node;
  };
  overview.append(
    stat(unpublished, 'local' + (unpublished > 1 ? 'es' : 'e') + ' seulement', unpublished ? 'local-only' : 'muted', 'local', 'Branches locales sans distante (ou dont la distante a été supprimée) : jamais poussées'),
    stat(toPush, 'à pousser', toPush ? 'ahead' : 'muted', null, 'Branches locales en avance sur leur distante'),
    stat(remoteOnly, 'distante' + (remoteOnly > 1 ? 's' : '') + ' seulement', remoteOnly ? 'remote-only' : 'muted', 'remote', 'Branches présentes sur le dépôt distant mais pas sur cet ordinateur'),
  );
  container.append(overview);

  const locals = refs.local.filter((ref) => matches(ref.name));
  section(container, 'local', 'LOCAL', refIcon('local', 'Branches de cet ordinateur'), locals.length, needle, (list) => {
    for (const ref of locals) {
      const item = row('local', ref, ref.name, handlers);
      const track = element('span', 'ref-track');
      if (ref.worktree) track.append(pill('worktree', null, `⧉ ${folderName(ref.worktree)}`, `Extraite dans la worktree ${ref.worktree} : double-clic pour l’ouvrir`));
      track.append(...localPills(ref, refs));
      item.append(track);
      item.title = `${ref.name}${ref.upstream ? ` → suit ${ref.upstream}` : ' (sans distante)'}${ref.current ? '' : ref.worktree ? ` — extraite dans ${ref.worktree}, double-clic pour l’ouvrir` : ' — double-clic pour basculer'}`;
      item.addEventListener('dblclick', () => { if (ref.worktree) onOpenWorktree(ref.worktree); else if (!ref.current) onActivate(ref.name); });
      list.append(item);
    }
  });

  const remotes = (refs.remotes?.length ? refs.remotes : [...new Set(refs.remote.map((ref) => ref.remote))].map((name) => ({ name })));
  const remoteRefs = refs.remote.filter((ref) => matches(ref.name));
  section(container, 'remote', 'DISTANT', refIcon('remote', 'Branches du serveur distant'), remoteRefs.length, needle, (list) => {
    for (const remote of remotes) {
      const members = remoteRefs.filter((ref) => ref.remote === remote.name);
      if (!members.length && needle) continue;
      const head = element('div', `remote-group provider-${remote.provider || 'git'}`);
      head.append(remoteLogo(remote, loadRemoteIcon), element('span', 'remote-name', remote.name));
      if (remote.path) head.append(element('span', 'remote-path', remote.path));
      head.title = remote.web ? `${remote.name} → ${remote.web}` : remote.name;
      head.addEventListener('contextmenu', (event) => { event.preventDefault(); onRemoteMenu(remote.name, event.clientX, event.clientY); });
      if (remote.web) {
        const open = element('button', 'remote-open', '↗');
        open.title = `Ouvrir ${remote.web} dans le navigateur`;
        open.addEventListener('click', () => onOpenRemote(remote.name));
        head.append(open);
      }
      list.append(head);
      for (const ref of members) {
        const item = row('remote', ref, ref.branch || ref.name, handlers);
        item.classList.add('remote-ref');
        item.append(ref.trackedBy
          ? pill('tracked', 'local', ref.trackedBy === ref.branch ? 'aussi en local' : `local : ${ref.trackedBy}`, `Suivie par la branche locale « ${ref.trackedBy} »`)
          : pill('remote-only', 'remote', 'distante seulement', 'Pas de branche locale : double-clic pour la créer et basculer dessus'));
        item.title = `${ref.name}${ref.trackedBy ? ` — suivie par ${ref.trackedBy}` : ' — double-clic pour la récupérer en local'}`;
        item.addEventListener('dblclick', () => { if (ref.trackedBy) onActivate(ref.trackedBy); else onCheckoutRemote(ref.name); });
        list.append(item);
      }
    }
  });

  // Worktrees : dossiers de travail du même dépôt, chacun sur sa branche. Double-clic pour en ouvrir une en onglet.
  const worktrees = (refs.worktrees || []).filter((item) => !item.bare && (matches(item.path) || matches(item.branch || '')));
  section(container, 'worktrees', 'WORKTREES', document.createTextNode('⧉'), worktrees.length, needle, (list) => {
    for (const worktree of worktrees) {
      const item = element('div', `ref-item worktree-item${worktree.current ? ' current' : ''}`);
      item.tabIndex = 0;
      item.append(element('span', 'ref-marker', worktree.current ? '✓' : ''), element('span', 'ref-name', folderName(worktree.path)));
      const track = element('span', 'ref-track');
      track.append(worktree.branch ? pill('tracked', 'local', worktree.branch, `Branche extraite dans ${worktree.path}`) : pill('gone', null, 'HEAD détachée', `HEAD détachée sur ${worktree.head?.slice(0, 12) || '?'}`));
      if (worktree.main) track.append(pill('synced', null, 'principale', 'Worktree principale du dépôt'));
      if (worktree.locked) track.append(pill('local-only', null, 'verrouillée', typeof worktree.locked === 'string' ? `Verrouillée : ${worktree.locked}` : 'Verrouillée (git worktree lock)'));
      if (worktree.prunable) track.append(pill('gone', null, 'introuvable', typeof worktree.prunable === 'string' ? worktree.prunable : 'Dossier introuvable : peut être oubliée (prune)'));
      item.append(track);
      item.title = `${worktree.path}${worktree.current ? ' (onglet courant)' : worktree.prunable ? '' : ' — double-clic pour l’ouvrir dans un onglet'}`;
      const open = () => { if (!worktree.current && !worktree.prunable) onOpenWorktree(worktree.path); };
      item.addEventListener('dblclick', open);
      item.addEventListener('keydown', (event) => { if (event.key === 'Enter') open(); });
      item.addEventListener('contextmenu', (event) => { event.preventDefault(); onWorktreeMenu(worktree, event.clientX, event.clientY); });
      list.append(item);
    }
  });

  const tags = (refs.tags || []).filter((ref) => matches(ref.name));
  section(container, 'tags', 'TAGS', document.createTextNode('◆'), tags.length, needle, (list) => {
    for (const ref of tags) list.append(row('tags', ref, ref.name, handlers));
  });
}
