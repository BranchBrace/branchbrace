// Conventional Commits (https://www.conventionalcommits.org) : « type(portée)!: description ».
export const COMMIT_TYPES = [
  ['feat', 'Nouvelle fonctionnalité', '✨'],
  ['fix', 'Correction de bug', '🐛'],
  ['docs', 'Documentation seulement', '📝'],
  ['style', 'Mise en forme, sans effet sur le code', '🎨'],
  ['refactor', 'Restructuration sans changement de comportement', '♻️'],
  ['perf', 'Amélioration des performances', '⚡'],
  ['test', 'Ajout ou correction de tests', '✅'],
  ['build', 'Build ou dépendances', '📦'],
  ['ci', 'Intégration continue', '🤖'],
  ['chore', 'Maintenance diverse', '🔧'],
  ['revert', 'Annulation d’un commit précédent', '⏪'],
];

const HEADER = /^([a-z]+)(?:\(([^()\r\n]*)\))?(!)?: (.*)$/i;

export function parseHeader(summary) {
  const match = HEADER.exec(summary || '');
  if (!match) return { type: '', scope: '', breaking: false, subject: summary || '' };
  return { type: match[1].toLowerCase(), scope: match[2] || '', breaking: Boolean(match[3]), subject: match[4] };
}

export function formatHeader({ type, scope = '', breaking = false, subject = '' }) {
  const cleanScope = scope.trim().replace(/[()\s]+/g, '-');
  return `${type}${cleanScope ? `(${cleanScope})` : ''}${breaking ? '!' : ''}: ${subject.trim()}`;
}

// Pied « BREAKING CHANGE: … » ajouté (ou remplacé) à la fin de la description.
export function withBreakingFooter(description, note) {
  const kept = (description || '').replace(/\n*^BREAKING CHANGE: [\s\S]*$/m, '').trimEnd();
  if (!note?.trim()) return kept;
  return `${kept ? `${kept}\n\n` : ''}BREAKING CHANGE: ${note.trim()}`;
}

// Portées déjà employées dans l'historique, les plus fréquentes d'abord : proposées à la saisie.
export function knownScopes(subjects) {
  const counts = new Map();
  for (const subject of subjects) {
    const { scope } = parseHeader(subject);
    if (scope) counts.set(scope, (counts.get(scope) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([scope]) => scope);
}
