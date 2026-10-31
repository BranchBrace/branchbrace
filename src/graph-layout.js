// Calcul des lanes du graphe de commits, sans dépendance au DOM (partagé par le renderer et les tests).
// Entrée : commits en ordre topologique, enfants avant parents. Sortie : une ligne par commit avec
// sa colonne et les segments à dessiner dans la hauteur de cette ligne.
//
// Un segment relie deux points exprimés en (lane, position verticale) où la position vaut
// 'top' (bord haut de la ligne), 'mid' (le nœud) ou 'bottom' (bord bas). Sa couleur suit `colorLane`.

export function layoutGraph(commits) {
  const lanes = [];
  const rows = [];
  let width = 0;

  for (const commit of commits) {
    let column = lanes.indexOf(commit.hash);
    if (column === -1) {
      column = lanes.indexOf(null);
      if (column === -1) { column = lanes.length; lanes.push(null); }
    }
    const segments = [];
    const top = lanes.slice();

    // Moitié haute : les lanes qui attendaient ce commit convergent vers le nœud, les autres le traversent.
    for (let lane = 0; lane < top.length; lane += 1) {
      if (top[lane] === null) continue;
      if (top[lane] === commit.hash) segments.push({ from: [lane, 'top'], to: [column, 'mid'], colorLane: lane });
      else segments.push({ from: [lane, 'top'], to: [lane, 'mid'], colorLane: lane });
      if (top[lane] === commit.hash) lanes[lane] = null;
    }

    // Moitié basse : le premier parent prolonge la colonne, les autres ouvrent ou rejoignent une lane.
    const [firstParent, ...otherParents] = commit.parents;
    lanes[column] = firstParent ?? null;
    for (const parent of otherParents) {
      let target = lanes.indexOf(parent);
      if (target === -1) {
        target = lanes.indexOf(null);
        if (target === -1) { target = lanes.length; lanes.push(null); }
        lanes[target] = parent;
      }
      segments.push({ from: [column, 'mid'], to: [target, 'bottom'], colorLane: target });
    }
    for (let lane = 0; lane < lanes.length; lane += 1) {
      if (lanes[lane] === null) continue;
      if (lane === column) segments.push({ from: [column, 'mid'], to: [column, 'bottom'], colorLane: column });
      else if (top[lane] !== null && top[lane] !== commit.hash && lanes[lane] === top[lane]) segments.push({ from: [lane, 'mid'], to: [lane, 'bottom'], colorLane: lane });
    }

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    width = Math.max(width, top.length, lanes.length, column + 1);
    rows.push({ hash: commit.hash, column, segments });
  }

  return { rows, width };
}
