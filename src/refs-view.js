// Panneau de gauche façon GitKraken : sections LOCAL / DISTANT / TAGS repliables et filtrables.
const SECTIONS = [
  ['local', 'LOCAL', '⌂'],
  ['remote', 'DISTANT', '☁'],
  ['tags', 'TAGS', '◆'],
];
const collapsed = new Set();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderRefs(container, refs, { filter, selectedHash, onSelect, onActivate, onContextMenu }) {
  const needle = filter.trim().toLowerCase();
  container.replaceChildren();
  for (const [kind, title, icon] of SECTIONS) {
    const items = (refs[kind] || []).filter((ref) => !needle || ref.name.toLowerCase().includes(needle));
    const section = element('section', `ref-section${collapsed.has(kind) && !needle ? ' collapsed' : ''}`);
    const header = element('button', 'ref-section-header');
    header.append(element('span', 'chevron', '›'), element('span', 'ref-section-icon', icon), element('span', 'ref-section-title', title), element('span', 'ref-count', String(items.length)));
    header.addEventListener('click', () => { if (collapsed.has(kind)) collapsed.delete(kind); else collapsed.add(kind); section.classList.toggle('collapsed'); });
    const list = element('div', 'ref-list');
    for (const ref of items) {
      const row = element('div', `ref-item${ref.current ? ' current' : ''}${ref.hash === selectedHash ? ' selected' : ''}`);
      row.tabIndex = 0;
      row.title = kind === 'local' ? `${ref.name}${ref.upstream ? ` → ${ref.upstream}` : ' (sans upstream)'}${ref.current ? '' : ' — double-clic pour basculer'}` : ref.name;
      row.append(element('span', 'ref-marker', ref.current ? '✓' : ''), element('span', 'ref-name', ref.name));
      if (ref.ahead || ref.behind) {
        const track = element('span', 'ref-track');
        if (ref.ahead) track.append(element('span', 'ahead', `↑${ref.ahead}`));
        if (ref.behind) track.append(element('span', 'behind', `↓${ref.behind}`));
        track.title = `${ref.ahead} commit(s) à pousser, ${ref.behind} à récupérer`;
        row.append(track);
      }
      row.addEventListener('click', () => onSelect(ref.hash));
      row.addEventListener('dblclick', () => { if (kind === 'local' && !ref.current) onActivate(ref.name); });
      row.addEventListener('contextmenu', (event) => { event.preventDefault(); onContextMenu(kind, ref, event.clientX, event.clientY); });
      list.append(row);
    }
    if (!items.length) list.append(element('p', 'ref-empty', needle ? 'Aucun résultat.' : 'Aucune.'));
    section.append(header, list);
    container.append(section);
  }
}
