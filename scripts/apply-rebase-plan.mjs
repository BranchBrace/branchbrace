import { readFile, writeFile } from 'node:fs/promises';

const todoPath = process.argv.at(-1);
const planPath = process.env.GIT_WORKBENCH_REBASE_PLAN;
if (!todoPath || !planPath) process.exit(2);
const plan = JSON.parse(await readFile(planPath, 'utf8'));
const todo = await readFile(todoPath, 'utf8');
const commits = [];
for (const line of todo.split('\n')) {
  const match = line.match(/^(pick|reword|edit|squash|fixup|drop)\s+([0-9a-f]+)(.*)$/i);
  if (match) commits.push({ shortHash: match[2], subject: match[3] });
}
const byFullHash = new Map();
for (const { hash } of plan) {
  const matches = commits.filter((commit) => hash.startsWith(commit.shortHash));
  if (matches.length !== 1 || byFullHash.has(hash)) process.exit(3);
  byFullHash.set(hash, matches[0]);
}
if (commits.length !== plan.length) process.exit(3);
const valid = new Set(['pick', 'drop', 'fixup']);
if (plan.some(({ action }) => !valid.has(action))) process.exit(4);
let priorCanAcceptFixup = false;
for (const item of plan) {
  if (item.action === 'fixup' && !priorCanAcceptFixup) process.exit(5);
  if (item.action === 'drop') continue;
  priorCanAcceptFixup = true;
}
const comments = todo.split('\n').filter((line) => !/^(pick|reword|edit|squash|fixup|drop)\s+[0-9a-f]+/i.test(line));
const lines = plan.map(({ action, hash }) => `${action} ${hash}${byFullHash.get(hash).subject}`);
await writeFile(todoPath, `${[...comments, ...lines].filter(Boolean).join('\n')}\n`, 'utf8');
