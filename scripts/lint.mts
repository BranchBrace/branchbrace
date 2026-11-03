import { readdir, readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';

// Tests et scripts tournent sous Node, qui retire les types sans compiler : chaque source doit s'y prêter
// (pas d'enum, de namespace ni de propriété de paramètre), et aucun fichier JavaScript ne doit revenir.
const roots = ['src', 'electron', 'test', 'scripts'];
const files: string[] = [];
const javascript: string[] = [];
async function collect(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(full);
    else if (/\.d\.ts$/.test(entry.name)) continue;
    else if (/\.(?:ts|cts|mts)$/.test(entry.name)) files.push(full);
    else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) javascript.push(full);
  }
}
for (const root of roots) await collect(root);
let failed = false;
for (const file of javascript) { failed = true; process.stderr.write(`${file}\nJavaScript source: convert it to TypeScript.\n`); }
for (const file of files) {
  try { stripTypeScriptTypes(await readFile(file, 'utf8')); }
  catch (error) { failed = true; process.stderr.write(`${file}\n${(error as Error).message}\n`); }
}
if (failed) process.exitCode = 1;
else process.stdout.write(`Checked ${files.length} TypeScript files for type stripping.\n`);
