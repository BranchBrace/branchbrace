// Pastilles « local » (ordinateur) et « distant » (nuage), partout les mêmes formes et les mêmes couleurs : on
// reconnaît d'un coup d'œil ce qui n'existe que sur cet ordinateur et ce qui est sur le serveur (GitHub…).
export type RefKind = 'local' | 'remote';

const PATHS: Record<RefKind, string> = {
  local: '<rect x="2.5" y="3" width="11" height="7.5" rx="1.2"/><path d="M1 13h14"/>',
  remote: '<path d="M4.6 12.5h7.2a2.8 2.8 0 0 0 .3-5.6 4.1 4.1 0 0 0-7.9-.9A3.3 3.3 0 0 0 4.6 12.5z"/>',
};
const TITLES: Record<RefKind, string> = { local: 'Sur cet ordinateur', remote: 'Sur le serveur distant' };

export function refIcon(kind: RefKind, title: string = TITLES[kind]): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = `ref-icon ref-icon-${kind}`;
  node.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${PATHS[kind]}</svg>`;
  if (title) node.title = title;
  return node;
}

// Légende courte : « [ordinateur] local  [nuage] distant ».
export function refLegend(): HTMLSpanElement {
  const legend = document.createElement('span');
  legend.className = 'ref-legend';
  for (const [kind, text] of [['local', 'local'], ['remote', 'distant']] as const) {
    const entry = document.createElement('span');
    entry.className = `ref-legend-item ${kind}`;
    entry.append(refIcon(kind), text);
    legend.append(entry);
  }
  return legend;
}
