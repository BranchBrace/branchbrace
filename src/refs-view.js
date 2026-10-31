// Panneau de gauche façon GitKraken : sections LOCAL / DISTANT / TAGS repliables et filtrables. Chaque branche locale
// dit où elle en est par rapport à sa distante (à jour, en avance/retard, jamais poussée, distante supprimée) ; les
// branches distantes sont regroupées par dépôt (GitHub, GitLab…) et signalent celles qui n'existent pas en local.
import { refIcon } from './ref-icons.js';

const collapsed = new Set();
const PROVIDERS = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const providerName = (remote) => PROVIDERS[remote?.provider] || remote?.host || 'distant';

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
  const { filter, onActivate, onCheckoutRemote, onOpenRemote } = handlers;
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
      track.append(...localPills(ref, refs));
      item.append(track);
      item.title = `${ref.name}${ref.upstream ? ` → suit ${ref.upstream}` : ' (sans distante)'}${ref.current ? '' : ' — double-clic pour basculer'}`;
      item.addEventListener('dblclick', () => { if (!ref.current) onActivate(ref.name); });
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
      head.append(element('span', 'remote-badge', providerName(remote)), element('span', 'remote-name', remote.name));
      if (remote.path) head.append(element('span', 'remote-path', remote.path));
      head.title = remote.web ? `${remote.name} → ${remote.web}` : remote.name;
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

  const tags = (refs.tags || []).filter((ref) => matches(ref.name));
  section(container, 'tags', 'TAGS', document.createTextNode('◆'), tags.length, needle, (list) => {
    for (const ref of tags) list.append(row('tags', ref, ref.name, handlers));
  });
}
