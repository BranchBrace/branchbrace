// Lecture et résolution des marqueurs de conflit laissés par Git dans un fichier :
//   <<<<<<< côté courant / [||||||| base] / ======= / >>>>>>> côté entrant
// Les lignes gardent leur fin de ligne d'origine (\n ou \r\n) : résoudre un bloc ne touche à rien d'autre.

const START = /^<{7}(?: (.*))?$/;
const BASE = /^\|{7}(?: (.*))?$/;
const SPLIT = /^={7}$/;
const END = /^>{7}(?: (.*))?$/;

const splitLines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) || [];
const bare = (line) => line.replace(/\r?\n$/, '');

// Découpe le texte en blocs : { type: 'text', lines } ou { type: 'conflict', ours, base, theirs, labels, startLine,
// endLine }. Les numéros de ligne (à partir de 1) couvrent les marqueurs inclus. Un marqueur orphelin reste du texte.
export function parseConflicts(text) {
  const lines = splitLines(text);
  const blocks = [];
  let plain = [];
  const flush = () => { if (plain.length) blocks.push({ type: 'text', lines: plain }); plain = []; };
  for (let i = 0; i < lines.length; i += 1) {
    const start = START.exec(bare(lines[i]));
    if (!start) { plain.push(lines[i]); continue; }
    const conflict = { type: 'conflict', ours: [], base: null, theirs: [], labels: { ours: start[1] || '', base: '', theirs: '' }, startLine: i + 1, endLine: 0 };
    let part = 'ours';
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const line = bare(lines[j]);
      const base = BASE.exec(line);
      if (part === 'ours' && base) { part = 'base'; conflict.base = []; conflict.labels.base = base[1] || ''; continue; }
      if (part !== 'theirs' && SPLIT.test(line)) { part = 'theirs'; continue; }
      const end = part === 'theirs' ? END.exec(line) : null;
      if (end) { conflict.labels.theirs = end[1] || ''; break; }
      if (START.test(line)) { j = lines.length; break; }
      conflict[part].push(lines[j]);
    }
    if (j >= lines.length) { plain.push(lines[i]); continue; }
    conflict.endLine = j + 1;
    flush();
    blocks.push(conflict);
    i = j;
  }
  flush();
  return blocks;
}

export const conflictCount = (text) => parseConflicts(text).filter((block) => block.type === 'conflict').length;

// Texte qui remplace un bloc pour un choix donné. Si la dernière ligne d'un côté n'a pas de fin de ligne (fin de
// fichier), « les deux » en ajoute une entre les côtés pour ne pas coller deux lignes.
export function resolveBlock(block, choice) {
  const join = (parts) => parts.join('');
  const eol = [...block.ours, ...block.theirs].find((line) => line.endsWith('\n'))?.endsWith('\r\n') ? '\r\n' : '\n';
  const terminated = (part) => (part.length && !part.at(-1).endsWith('\n') ? [...part.slice(0, -1), part.at(-1) + eol] : part);
  switch (choice) {
    case 'ours': return join(block.ours);
    case 'theirs': return join(block.theirs);
    case 'both': return join([...terminated(block.ours), ...block.theirs]);
    case 'both-theirs-first': return join([...terminated(block.theirs), ...block.ours]);
    case 'base': return join(block.base || []);
    default: throw new Error(`Unknown conflict resolution: ${choice}`);
  }
}

// Étendue d'un texte inséré à partir du début d'une ligne : fin exclusive, comme une plage Monaco. Un texte qui finit
// par une fin de ligne s'arrête en colonne 1 de la ligne suivante ; un texte vide donne une plage vide.
export function textSpan(startLine, text) {
  const lines = text.split('\n');
  return { startLine, endLine: startLine + lines.length - 1, endColumn: lines.at(-1).length + 1 };
}

// Applique un même choix à tous les conflits restants.
export function resolveAll(text, choice) {
  return parseConflicts(text).map((block) => (block.type === 'text' ? block.lines.join('') : resolveBlock(block, choice))).join('');
}
