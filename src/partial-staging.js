// Indexation partielle (A3), sans Git ni système de fichiers : à partir des deux côtés du diff affiché, des blocs de
// changement calculés par Monaco et des lignes choisies, calcule le contenu que l'index doit avoir après l'opération
// et le patch que `git apply --cached` (ou `--cached --reverse` pour désindexer) applique pour l'obtenir.
//
// Les contenus sont des chaînes « latin1 » (un caractère par octet) : le patch reproduit les octets exacts du fichier
// quel que soit son encodage. Les numéros de ligne sont ceux de Monaco, qui coupe sur \r\n, \r ou \n : un fichier
// terminé par un retour à la ligne y a une dernière ligne vide (« fantôme ») qui n'existe pas pour Git. La choisir
// revient à choisir l'état de la fin de fichier (avec ou sans retour à la ligne final).

const CONTEXT = 3;

export class PartialStagingError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function splitLines(content) {
  const texts = [];
  const eols = [];
  const pattern = /\r\n|\r|\n/g;
  let start = 0;
  for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
    texts.push(content.slice(start, match.index));
    eols.push(match[0]);
    start = match.index + match[0].length;
  }
  texts.push(content.slice(start));
  eols.push('');
  // Lignes réelles (pour Git) : toutes sauf la ligne vide finale.
  return { texts, eols, real: texts.at(-1) === '' ? texts.length - 1 : texts.length };
}

const isLineNumber = (value) => Number.isInteger(value) && value >= 0;
const range = (start, count) => Array.from({ length: count }, (_, k) => start + k);

// Blocs `{ originalStart, originalCount, modifiedStart, modifiedCount }` (début 1-based ; pour un bloc vide d'un côté,
// la ligne qui suit l'emplacement). Refuse un découpage qui ne décrit pas exactement les deux contenus : hors des
// blocs, les lignes doivent être identiques des deux côtés (seule la fin de ligne peut différer).
function alignment(left, right, changes) {
  if (!Array.isArray(changes)) throw new PartialStagingError('diff-outdated');
  const blocks = changes.map((change) => {
    const block = {
      originalStart: change?.originalStart, originalCount: change?.originalCount,
      modifiedStart: change?.modifiedStart, modifiedCount: change?.modifiedCount,
    };
    if (!Object.values(block).every(isLineNumber) || block.originalStart < 1 || block.modifiedStart < 1) throw new PartialStagingError('diff-outdated');
    return block;
  }).sort((a, b) => a.originalStart - b.originalStart);
  const segments = [];
  let i = 1;
  let j = 1;
  const same = (count) => {
    for (let k = 0; k < count; k += 1) {
      if (left.texts[i - 1 + k] !== right.texts[j - 1 + k]) throw new PartialStagingError('diff-outdated');
      segments.push({ left: i + k, right: j + k });
    }
    i += count; j += count;
  };
  for (const block of blocks) {
    const gap = block.originalStart - i;
    if (gap < 0 || block.modifiedStart - j !== gap) throw new PartialStagingError('diff-outdated');
    same(gap);
    if (i + block.originalCount - 1 > left.texts.length || j + block.modifiedCount - 1 > right.texts.length) throw new PartialStagingError('diff-outdated');
    segments.push({ removed: range(i, block.originalCount), added: range(j, block.modifiedCount) });
    i += block.originalCount; j += block.modifiedCount;
  }
  if (left.texts.length - i !== right.texts.length - j) throw new PartialStagingError('diff-outdated');
  same(left.texts.length - i + 1);
  return segments;
}

// Une ligne choisie emporte sa fin de ligne : la ligne fantôme suit la ligne qui la précède dans son bloc.
function chosen(lines, selected, side) {
  const set = new Set(lines.filter((line) => selected.has(line)));
  const phantom = side.real + 1;
  if (phantom === side.texts.length && lines.includes(phantom) && set.has(phantom - 1)) set.add(phantom);
  return set;
}

function quotePath(name) {
  const bytes = Buffer.from(name, 'utf8');
  if (![...bytes].some((byte) => byte < 0x21 || byte > 0x7e || byte === 0x22 || byte === 0x5c)) return name;
  const escapes = { 0x07: '\\a', 0x08: '\\b', 0x09: '\\t', 0x0a: '\\n', 0x0b: '\\v', 0x0c: '\\f', 0x0d: '\\r', 0x22: '\\"', 0x5c: '\\\\' };
  let quoted = '"';
  for (const byte of bytes) {
    if (escapes[byte]) quoted += escapes[byte];
    else if (byte < 0x20 || byte > 0x7e) quoted += `\\${byte.toString(8).padStart(3, '0')}`;
    else quoted += String.fromCharCode(byte);
  }
  return `${quoted}"`;
}

// `mode` : 'stage' (gauche = index, droite = fichier) construit le patch gauche → résultat ; 'unstage' (gauche = HEAD,
// droite = index) construit le patch résultat → droite, que Git applique à l'envers. `left`/`right` : contenus, null si
// le fichier n'existe pas de ce côté ; `selection` : { original: [lignes de gauche], modified: [lignes de droite] }.
// Renvoie le texte du patch et le contenu attendu dans l'index ({ content, exists }), ou lève PartialStagingError.
export function buildPartialPatch({ path: filePath, mode, left, right, changes, selection, fileMode = '100644' }) {
  if (mode !== 'stage' && mode !== 'unstage') throw new PartialStagingError('invalid-content');
  const L = splitLines(left ?? '');
  const R = splitLines(right ?? '');
  if (L.eols.includes('\r') || R.eols.includes('\r')) throw new PartialStagingError('partial-staging-unsupported');
  const pick = (values) => new Set(Array.isArray(values) ? values.filter(isLineNumber) : []);
  const selectedLeft = pick(selection?.original);
  const selectedRight = pick(selection?.modified);
  const stage = mode === 'stage';

  // Lignes réelles dans l'ordre du patch ; `kind` : same (des deux côtés), removed (gauche), added (droite).
  const ops = [];
  let touched = false;
  let eofChosen = false;
  for (const segment of alignment(L, R, changes)) {
    if (!segment.removed) {
      if (segment.left > L.real) continue;
      ops.push({ kind: 'same', text: L.texts[segment.left - 1], eolL: L.eols[segment.left - 1], eolR: R.eols[segment.right - 1], lastL: segment.left === L.real, lastR: segment.right === R.real });
      continue;
    }
    const removed = chosen(segment.removed, selectedLeft, L);
    const added = chosen(segment.added, selectedRight, R);
    if (removed.size || added.size) touched = true;
    if (removed.has(L.real + 1) || added.has(R.real + 1)) eofChosen = true;
    for (const line of segment.removed) if (line <= L.real) ops.push({ kind: 'removed', text: L.texts[line - 1], eolL: L.eols[line - 1], selected: removed.has(line) });
    for (const line of segment.added) if (line <= R.real) ops.push({ kind: 'added', text: R.texts[line - 1], eolR: R.eols[line - 1], selected: added.has(line) });
  }
  if (!touched) throw new PartialStagingError('nothing-selected');

  // Côté fixe : gauche (indexer) ou droite (désindexer), fins de ligne d'origine. Côté résultat : lignes gardées.
  for (const op of ops) {
    op.inFixed = stage ? op.kind !== 'added' : op.kind !== 'removed';
    op.inResult = op.kind === 'same' || (op.kind === (stage ? 'added' : 'removed')) === op.selected;
    op.fixedEol = stage ? op.eolL : op.eolR;
  }
  // Fin de ligne côté résultat : celle de la ligne d'origine ; une ancienne dernière ligne que d'autres suivent désormais
  // prend celle de l'autre côté (à défaut celle du fichier). La dernière ligne garde l'état de fin de fichier de la base,
  // sauf si la fin de fichier a été choisie ou si les lignes qui la suivaient ont été retirées : celui de la cible.
  const fallback = R.eols.find(Boolean) || L.eols.find(Boolean) || '\n';
  const own = (op) => (op.kind === 'same' ? (stage ? op.eolL : op.eolR) : op.eolL ?? op.eolR);
  const other = (op) => (op.kind === 'same' ? (stage ? op.eolR : op.eolL) : '');
  const targetEndsWithNewline = stage ? R.real < R.texts.length && R.real > 0 : L.real < L.texts.length && L.real > 0;
  const result = ops.filter((op) => op.inResult);
  result.forEach((op, index) => {
    if (index < result.length - 1) op.resultEol = own(op) || other(op) || fallback;
    else if (eofChosen) op.resultEol = targetEndsWithNewline ? own(op) || other(op) || fallback : '';
    else if (op.kind === 'same') op.resultEol = (stage ? op.lastL : op.lastR) ? own(op) : other(op);
    else op.resultEol = own(op);
  });
  const content = result.map((op) => op.text + op.resultEol).join('');
  const exists = content !== '' || (left !== null && right !== null);
  const fixed = stage ? left : right;
  if (fixed === content && (fixed !== null) === exists) throw new PartialStagingError('nothing-selected');
  const preExists = stage ? left !== null : exists;
  const postExists = stage ? exists : right !== null;

  const lines = [];
  for (const op of ops) {
    const fixedLine = op.inFixed ? op.text + op.fixedEol : null;
    const resultLine = op.inResult ? op.text + op.resultEol : null;
    const [before, after] = stage ? [fixedLine, resultLine] : [resultLine, fixedLine];
    if (before !== null && before === after) lines.push({ type: ' ', text: before });
    else {
      if (before !== null) lines.push({ type: '-', text: before });
      if (after !== null) lines.push({ type: '+', text: after });
    }
  }

  const header = [`diff --git ${quotePath(`a/${filePath}`)} ${quotePath(`b/${filePath}`)}`];
  if (!preExists) header.push(`new file mode ${fileMode}`);
  if (!postExists) header.push(`deleted file mode ${fileMode}`);
  header.push(`--- ${preExists ? quotePath(`a/${filePath}`) : '/dev/null'}`, `+++ ${postExists ? quotePath(`b/${filePath}`) : '/dev/null'}`);
  return { patch: header.map((line) => `${line}\n`).join('') + hunks(lines), content, exists };
}

function hunks(lines) {
  const groups = [];
  lines.forEach((line, index) => {
    if (line.type === ' ') return;
    const last = groups.at(-1);
    if (last && index - last.end <= 2 * CONTEXT + 1) last.end = index;
    else groups.push({ start: index, end: index });
  });
  const count = (items, type) => items.filter((line) => line.type === ' ' || line.type === type).length;
  let output = '';
  for (const group of groups) {
    const from = Math.max(0, group.start - CONTEXT);
    const body = lines.slice(from, Math.min(lines.length, group.end + CONTEXT + 1));
    const before = lines.slice(0, from);
    const preCount = count(body, '-');
    const postCount = count(body, '+');
    output += `@@ -${count(before, '-') + (preCount ? 1 : 0)},${preCount} +${count(before, '+') + (postCount ? 1 : 0)},${postCount} @@\n`;
    for (const line of body) {
      output += line.type + line.text;
      if (!line.text.endsWith('\n')) output += '\n\\ No newline at end of file\n';
    }
  }
  return output;
}
