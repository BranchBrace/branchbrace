import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['src', 'electron', 'test', 'scripts'];
const files = [];
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(full);
    else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) files.push(full);
  }
}
for (const root of roots) await collect(root);
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { failed = true; process.stderr.write(`${file}\n${result.stderr}`); }
}
if (failed) process.exitCode = 1;
else process.stdout.write(`Syntax checked ${files.length} JavaScript files.\n`);
