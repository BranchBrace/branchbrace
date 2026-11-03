import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
// Tout le dépôt, puis le processus principal seul : sans le DOM, il ne doit dépendre d'aucune API du rendu.
for (const project of ['tsconfig.json', 'tsconfig.main.json']) {
  const result = spawnSync(process.execPath, [tsc, '-p', project, '--noEmit'], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { license?: string; private?: boolean };
if (manifest.license !== 'MIT' || manifest.private !== true) throw new Error('Package must remain private and MIT-licensed.');
const source = (await readdir('src')).join(' ');
if (!source.includes('main.ts') || !source.includes('index.html')) throw new Error('Desktop entry point is missing.');
process.stdout.write('Types and project invariants checked.\n');
