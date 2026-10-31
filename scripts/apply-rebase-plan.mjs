import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Éditeur appelé par Git pendant un rebase interactif lancé par l'application, dans deux rôles :
// - GIT_SEQUENCE_EDITOR (fichier git-rebase-todo) : remplace la liste par le plan validé ;
// - GIT_EDITOR (message de commit) : écrit le message choisi pour un reword ou un squash, d'après la dernière ligne
//   de `rebase-merge/done` (le commit en cours). Sans message prévu, le fichier proposé par Git reste inchangé.
const targetPath = process.argv.at(-1);
const planPath = process.env.GIT_WORKBENCH_REBASE_PLAN;
if (!targetPath || !planPath) process.exit(2);
const plan = JSON.parse(await readFile(planPath, 'utf8'));
const COMMAND = /^(pick|reword|edit|squash|fixup|drop|p|r|e|s|f|d)\s+([0-9a-f]+)(.*)$/i;

if (path.basename(targetPath) !== 'git-rebase-todo') {
  const donePath = process.env.GIT_WORKBENCH_REBASE_DONE;
  const done = donePath ? await readFile(donePath, 'utf8').catch(() => '') : '';
  const current = done.split('\n').map((line) => COMMAND.exec(line.trim())).filter(Boolean).at(-1);
  const item = current && plan.find((step) => step.hash.startsWith(current[2]) && typeof step.message === 'string');
  if (item) await writeFile(targetPath, `${item.message.trimEnd()}\n`, 'utf8');
  process.exit(0);
}

const todo = await readFile(targetPath, 'utf8');
const commits = [];
for (const line of todo.split('\n')) {
  const match = line.match(COMMAND);
  if (match) commits.push({ shortHash: match[2], subject: match[3] });
}
const byFullHash = new Map();
for (const { hash } of plan) {
  const matches = commits.filter((commit) => hash.startsWith(commit.shortHash));
  if (matches.length !== 1 || byFullHash.has(hash)) process.exit(3);
  byFullHash.set(hash, matches[0]);
}
if (commits.length !== plan.length) process.exit(3);
const valid = new Set(['pick', 'reword', 'squash', 'fixup', 'drop']);
if (plan.some(({ action }) => !valid.has(action))) process.exit(4);
let priorCanAcceptFixup = false;
for (const item of plan) {
  if ((item.action === 'fixup' || item.action === 'squash') && !priorCanAcceptFixup) process.exit(5);
  if (item.action === 'drop') continue;
  priorCanAcceptFixup = true;
}
const comments = todo.split('\n').filter((line) => !COMMAND.test(line));
const lines = plan.map(({ action, hash }) => `${action} ${hash}${byFullHash.get(hash).subject}`);
await writeFile(targetPath, `${[...comments, ...lines].filter(Boolean).join('\n')}\n`, 'utf8');
