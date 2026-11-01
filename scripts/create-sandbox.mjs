// Crée un dépôt Git d'expérimentation pour BranchBrace : plusieurs auteurs, merges, tags, branches distantes,
// une branche à rebaser, une branche en conflit et des changements non commités.
// Usage : node scripts/create-sandbox.mjs [dossier]   (défaut : ~/branchbrace-sandbox)
// Refuse d'écrire dans un dossier existant non vide : on ne touche jamais à un dépôt réel.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const target = path.resolve(process.argv[2] || path.join(os.homedir(), 'branchbrace-sandbox'));
if (existsSync(target) && readdirSync(target).length) {
  console.error(`Le dossier ${target} existe et n'est pas vide : supprimez-le ou choisissez un autre chemin.`);
  process.exit(1);
}
mkdirSync(target, { recursive: true });
const remote = path.join(target, 'remote.git');
const repo = path.join(target, 'demo-app');

const AUTHORS = {
  alice: ['Alice Martin', 'alice@example.invalid'],
  bruno: ['Bruno Lefèvre', 'bruno@example.invalid'],
  chloe: ['Chloé Durand', 'chloe@example.invalid'],
  david: ['David Nguyen', 'david@example.invalid'],
};
const start = Date.now() - 40 * 86400 * 1000;
let tick = 0;

function git(cwd, args, env = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} a échoué :\n${result.stderr}`);
  return result.stdout.trim();
}
const write = (file, content) => { mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); writeFileSync(path.join(repo, file), content); };
const append = (file, content) => appendFileSync(path.join(repo, file), content);

// Chaque commit avance d'environ 9 heures pour étaler l'historique sur plusieurs semaines.
function commit(author, message, files = {}) {
  for (const [file, content] of Object.entries(files)) write(file, content);
  git(repo, ['add', '--all']);
  tick += 1;
  const date = new Date(start + tick * 9 * 3600 * 1000).toISOString();
  const [name, email] = AUTHORS[author];
  git(repo, ['commit', '--quiet', '-m', message], { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}
function merge(author, branch, message) {
  tick += 1;
  const date = new Date(start + tick * 9 * 3600 * 1000).toISOString();
  const [name, email] = AUTHORS[author];
  git(repo, ['merge', '--no-ff', '--quiet', '-m', message, branch], { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}
const checkout = (...args) => git(repo, ['switch', '--quiet', ...args]);

git(target, ['init', '--quiet', '--bare', '-b', 'main', remote]);
git(target, ['init', '--quiet', '-b', 'main', repo]);
git(repo, ['config', 'user.name', 'Sandbox']);
git(repo, ['config', 'user.email', 'sandbox@example.invalid']);
git(repo, ['config', 'core.autocrlf', 'false']);
git(repo, ['remote', 'add', 'origin', remote]);

commit('alice', 'chore: initialiser le projet', { 'README.md': '# Demo App\n\nApplication de démonstration pour BranchBrace.\n', '.gitignore': 'node_modules/\ndist/\n' });
commit('alice', 'feat: ajouter le point d’entrée', { 'src/app.js': "export function start() {\n  console.log('Demo App');\n}\n" });
commit('bruno', 'docs: décrire l’installation', { 'docs/install.md': '# Installation\n\n1. Cloner le dépôt\n2. Lancer `npm start`\n' });
git(repo, ['tag', '-a', 'v0.1.0', '-m', 'Première version']);

checkout('-c', 'feature/login');
commit('chloe', 'feat(login): formulaire de connexion', { 'src/login.js': 'export const login = (user) => Boolean(user);\n' });
commit('chloe', 'test(login): couvrir les cas vides', { 'test/login.test.js': "import { login } from '../src/login.js';\nconsole.assert(!login(''));\n" });
checkout('main');
commit('alice', 'fix: corriger le message de démarrage', { 'src/app.js': "export function start() {\n  console.log('Demo App démarrée');\n}\n" });
merge('alice', 'feature/login', 'Merge branch feature/login');

checkout('-c', 'fix/typo');
commit('david', 'fix(docs): coquille dans l’installation', { 'docs/install.md': '# Installation\n\n1. Cloner le dépôt\n2. Lancer `npm start`\n3. Ouvrir http://localhost:3000\n' });
checkout('main');
merge('bruno', 'fix/typo', 'Merge branch fix/typo');
git(repo, ['tag', '-a', 'v0.2.0', '-m', 'Connexion utilisateur']);
git(repo, ['push', '--quiet', '-u', 'origin', 'main', '--tags']);

checkout('-c', 'feature/dark-mode');
commit('chloe', 'feat(theme): variables de couleur', { 'src/theme.css': ':root { --bg: #fff; --fg: #111; }\n' });
commit('chloe', 'feat(theme): mode sombre', { 'src/theme.css': ':root { --bg: #fff; --fg: #111; }\n@media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #eee; } }\n' });
commit('david', 'style(theme): contraste des liens', { 'src/theme.css': ':root { --bg: #fff; --fg: #111; --link: #0669f7; }\n@media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #eee; --link: #6aa8ff; } }\n' });
git(repo, ['push', '--quiet', '-u', 'origin', 'feature/dark-mode']);

checkout('main');
checkout('-c', 'feature/remote-only');
commit('bruno', 'feat(api): client HTTP minimal', { 'src/api.js': 'export const get = (url) => fetch(url).then((r) => r.json());\n' });
git(repo, ['push', '--quiet', 'origin', 'feature/remote-only']);
checkout('main');
git(repo, ['branch', '--quiet', '-D', 'feature/remote-only']);

checkout('-c', 'release/1.0');
commit('alice', 'chore(release): préparer la 1.0', { 'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n\n- Connexion utilisateur\n' });
checkout('main');

// Branche locale à nettoyer par rebase interactif : un WIP, un fixup et un commit à écarter.
checkout('-c', 'experiment/rebase-me');
commit('david', 'feat(search): champ de recherche', { 'src/search.js': 'export const search = (items, q) => items.filter((i) => i.includes(q));\n' });
commit('david', 'wip', { 'src/search.js': 'export const search = (items, q) => items.filter((i) => i.toLowerCase().includes(q.toLowerCase()));\n' });
commit('david', 'fixup: oubli du trim', { 'src/search.js': 'export const search = (items, q) => items.filter((i) => i.toLowerCase().includes(q.trim().toLowerCase()));\n' });
commit('david', 'debug: logs temporaires', { 'src/debug.js': "console.log('debug');\n" });
checkout('main');

// Branche qui modifie la même ligne que main : rebase ou cherry-pick en conflit garanti.
checkout('-c', 'conflict/readme');
commit('bruno', 'docs: nouveau titre du README', { 'README.md': '# Demo App — édition Bruno\n\nApplication de démonstration pour BranchBrace.\n' });
checkout('main');
commit('chloe', 'docs: titre du README en anglais', { 'README.md': '# Demo App — English title\n\nApplication de démonstration pour BranchBrace.\n' });

// main a un commit d'avance sur origin/main (↑1, de quoi tester le push vers le dépôt nu local).
// Puis des changements non commités : un fichier indexé, un modifié et un non suivi (ligne WIP).
write('src/config.js', 'export const port = 3000;\n');
git(repo, ['add', 'src/config.js']);
append('src/app.js', '// TODO: lire la configuration\n');
write('notes.txt', 'Idées en vrac pour la suite.\n');

console.log(`Bac à sable prêt :\n  dépôt de travail : ${repo}\n  remote (dépôt nu) : ${remote}`);
