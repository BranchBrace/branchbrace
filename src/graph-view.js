import { layoutGraph } from './graph-layout.js';

// Rendu du graphe central façon GitKraken : colonnes branche/tag · graphe · message. L'auteur figure dans le
// nœud (initiales), la date et le SHA dans l'infobulle de la ligne et dans le panneau de détail.
export const WIP = 'WIP';
const ROW = 34;
const LANE = 26;
const PAD = 12;
const NODE = 12;
const CORNER = 9;
const COLORS = ['#3fa0a4', '#e2b570', '#9f3c91', '#b7d974', '#bc5960', '#86e0ce', '#eee98a', '#5da75d', '#913a52', '#81afb5'];
const SVG = 'http://www.w3.org/2000/svg';

export const laneColor = (lane) => COLORS[lane % COLORS.length];
const laneX = (lane) => PAD + lane * LANE + LANE / 2;
const levelY = { top: 0, mid: ROW / 2, bottom: ROW };

function svg(name, attributes) {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

// Tracés à angle arrondi : une branche quitte le nœud à l'horizontale puis tourne vers le bas, et une lane qui
// converge descend puis tourne vers le nœud.
function segmentPath({ from: [lane1, level1], to: [lane2, level2] }) {
  const [x1, y1, x2, y2] = [laneX(lane1), levelY[level1], laneX(lane2), levelY[level2]];
  if (x1 === x2) return `M${x1} ${y1}L${x2} ${y2}`;
  const direction = Math.sign(x2 - x1);
  const radius = Math.min(CORNER, Math.abs(x2 - x1), Math.abs(y2 - y1));
  if (level1 === 'top') return `M${x1} ${y1}L${x1} ${y2 - radius}Q${x1} ${y2} ${x1 + direction * radius} ${y2}L${x2} ${y2}`;
  return `M${x1} ${y1}L${x2 - direction * radius} ${y1}Q${x2} ${y1} ${x2} ${y1 + radius}L${x2} ${y2}`;
}

function initials(name) {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

const relative = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
export function relativeDate(timestamp, now = Date.now()) {
  const seconds = Math.round(timestamp - now / 1000);
  for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return 'à l’instant';
}

// Une branche locale et sa copie distante au même commit forment une seule étiquette, comme dans GitKraken.
function refLabels(refs) {
  const labels = [];
  const locals = new Map();
  for (const ref of refs.filter((item) => item.type === 'local')) { const label = { text: ref.name, local: true, remote: false, head: ref.head, branch: ref.name }; locals.set(ref.name, label); labels.push(label); }
  for (const ref of refs.filter((item) => item.type === 'remote')) {
    const local = locals.get(ref.name.slice(ref.name.indexOf('/') + 1));
    if (local) local.remote = true;
    else labels.push({ text: ref.name, local: false, remote: true, head: false, remoteName: ref.name });
  }
  if (refs.some((item) => item.type === 'head')) labels.unshift({ text: 'HEAD', local: false, remote: false, head: true });
  for (const ref of refs.filter((item) => item.type === 'tag')) labels.push({ text: ref.name, tag: true, tagName: ref.name });
  // HEAD d'abord, puis les branches locales, les distantes et enfin les tags.
  const rank = (label) => (label.head ? 0 : label.local ? 1 : label.remote ? 2 : 3);
  return labels.sort((a, b) => rank(a) - rank(b));
}

// Infobulle : où en est une branche locale par rapport à sa distante.
function trackingText(label, refs) {
  const local = refs?.local?.find((ref) => ref.name === label.branch);
  if (!local) return '';
  if (local.gone) return `\nSa distante ${local.upstream} a été supprimée.`;
  if (!local.upstream) return '\nSeulement sur cet ordinateur : jamais poussée.';
  if (!local.ahead && !local.behind) return `\nÀ jour avec ${local.upstream}.`;
  return `\n${local.ahead ? `${local.ahead} commit(s) à pousser` : ''}${local.ahead && local.behind ? ', ' : ''}${local.behind ? `${local.behind} à récupérer` : ''} (${local.upstream}).`;
}

function labelChip(label, color, handlers, refs) {
  const chip = document.createElement('span');
  chip.className = `ref-chip${label.head ? ' head' : ''}${label.tag ? ' tag' : ''}${!label.local && label.remote ? ' remote' : ''}`;
  chip.style.setProperty('--lane', color);
  const name = document.createElement('span'); name.className = 'ref-chip-name';
  name.textContent = `${label.head ? '✓ ' : ''}${label.tag ? '◆ ' : ''}${!label.local && label.remote ? '☁ ' : ''}${label.text}`;
  const icons = document.createElement('span'); icons.className = 'ref-chip-icons';
  icons.textContent = label.local ? `⌂${label.remote ? '☁' : ''}` : '';
  chip.append(name, icons);
  chip.title = label.tag ? `Tag ${label.text}` : label.local ? `Branche locale ${label.text}${label.remote ? ' — sa distante pointe sur le même commit' : ''}${trackingText(label, refs)}${label.head ? '' : '\nDouble-clic pour basculer'}` : `Branche distante ${label.text} (sur le serveur, pas en local à ce commit)`;
  if (label.branch) chip.addEventListener('dblclick', (event) => { event.stopPropagation(); if (!label.head) handlers.onCheckout(label.branch); });
  const ref = label.branch ? ['local', label.branch] : label.remoteName ? ['remote', label.remoteName] : label.tagName ? ['tags', label.tagName] : null;
  if (ref) chip.addEventListener('contextmenu', (event) => { event.preventDefault(); event.stopPropagation(); handlers.onRefMenu(ref[0], ref[1], event.clientX, event.clientY); });
  return chip;
}

function node(drawing, commit, cx, color, isWip) {
  const cy = ROW / 2;
  if (isWip) { drawing.append(svg('circle', { cx, cy, r: NODE - 1, fill: '#0a1124', stroke: color, 'stroke-width': 2, 'stroke-dasharray': '3 2.5' })); return; }
  if (commit.parents.length > 1) { drawing.append(svg('circle', { cx, cy, r: 5.5, fill: color, stroke: '#0a1124', 'stroke-width': 1.5 })); return; }
  // Avatar : anneau à la couleur de la lane autour des initiales de l'auteur (calculées localement, sans service d'avatars).
  drawing.append(svg('circle', { cx, cy, r: NODE, fill: color }), svg('circle', { cx, cy, r: NODE - 2.5, fill: '#101a30' }));
  const text = svg('text', { x: cx, y: cy + 3.5, 'text-anchor': 'middle', 'font-size': 9.5, 'font-weight': 800, fill: color });
  text.textContent = initials(commit.author);
  drawing.append(text);
}

export function renderGraph(container, { commits, head, wip, selected, refs }, handlers) {
  const rows = wip && head ? [{ hash: WIP, parents: [head], author: '', timestamp: Date.now() / 1000, refs: [], subject: '', summary: '' }, ...commits] : commits;
  const layout = layoutGraph(rows);
  const graphWidth = PAD * 2 + Math.max(layout.width, 1) * LANE;
  // Posée sur le panneau pour que l'en-tête des colonnes partage la largeur du graphe.
  (container.parentElement ?? container).style.setProperty('--graph-width', `${Math.min(graphWidth, 420)}px`);
  container.replaceChildren();

  rows.forEach((commit, index) => {
    const { column, segments } = layout.rows[index];
    const color = laneColor(column);
    const isWip = commit.hash === WIP;
    const labels = refLabels(commit.refs);
    const row = document.createElement('div');
    row.className = `graph-row${commit.hash === selected ? ' selected' : ''}${commit.hash === head ? ' is-head' : ''}${isWip ? ' wip' : ''}${labels.length ? ' has-refs' : ''}`;
    row.dataset.hash = commit.hash;
    row.style.setProperty('--lane', color);
    if (!isWip) row.title = `${commit.author} · ${relativeDate(commit.timestamp)} · ${new Date(commit.timestamp * 1000).toLocaleString('fr-FR')}\n${commit.hash.slice(0, 7)} · ${commit.subject}`;

    const refsCell = document.createElement('div'); refsCell.className = 'cell refs';
    if (labels.length) {
      refsCell.append(labelChip(labels[0], color, handlers, refs));
      if (labels.length > 1) {
        const more = document.createElement('span'); more.className = 'ref-more'; more.textContent = `+${labels.length - 1}`;
        more.title = labels.slice(1).map((label) => `${label.tag ? '◆' : label.local ? '⌂' : '☁'} ${label.text}`).join('\n');
        refsCell.append(more);
      }
    }

    const graphCell = document.createElement('div'); graphCell.className = 'cell graph';
    const drawing = svg('svg', { width: graphWidth, height: ROW, viewBox: `0 0 ${graphWidth} ${ROW}` });
    const cx = laneX(column);
    // Bandeau teinté qui prolonge l'étiquette de branche jusqu'au nœud, comme dans GitKraken.
    if (labels.length) drawing.append(svg('rect', { x: 0, y: 3, width: cx, height: ROW - 6, fill: color, opacity: 0.2 }), svg('line', { x1: 0, y1: ROW / 2, x2: cx, y2: ROW / 2, stroke: color, 'stroke-width': 1.5, opacity: 0.7 }));
    for (const segment of segments) {
      drawing.append(svg('path', { d: segmentPath(segment), stroke: laneColor(segment.colorLane), 'stroke-width': 2.5, fill: 'none', 'stroke-linecap': 'round', 'stroke-dasharray': isWip && segment.from[1] === 'mid' ? '3 4' : 'none' }));
    }
    node(drawing, commit, cx, color, isWip);
    graphCell.append(drawing);

    const message = document.createElement('div'); message.className = 'cell message';
    if (isWip) {
      const tag = document.createElement('span'); tag.className = 'wip-tag'; tag.textContent = '// WIP';
      const count = document.createElement('span'); count.className = 'wip-count'; count.textContent = `✎ ${wip}`; count.title = `Fichier${wip > 1 ? 's' : ''} modifié${wip > 1 ? 's' : ''} : ${wip}`;
      message.append(tag, count);
    } else {
      const subject = document.createElement('span'); subject.className = 'subject'; subject.textContent = commit.subject;
      message.append(subject);
      if (commit.summary) { const summary = document.createElement('span'); summary.className = 'summary'; summary.textContent = commit.summary; message.append(summary); }
    }
    row.append(refsCell, graphCell, message);
    row.addEventListener('click', () => handlers.onSelect(commit.hash));
    if (!isWip) row.addEventListener('contextmenu', (event) => { event.preventDefault(); handlers.onContextMenu(commit, event.clientX, event.clientY); });
    container.append(row);
  });
}
