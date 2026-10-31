import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';

const result = await new Promise((resolve) => {
  const child = spawnSync(process.execPath, ['scripts/lint.mjs'], { encoding: 'utf8' });
  resolve(child);
});
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status || 1);
}
const manifest = JSON.parse(await (await import('node:fs/promises')).readFile('package.json', 'utf8'));
if (manifest.license !== 'UNLICENSED' || manifest.private !== true) throw new Error('Package must remain private and UNLICENSED.');
const source = (await readdir('src')).join(' ');
if (!source.includes('main.js') || !source.includes('index.html')) throw new Error('Desktop entry point is missing.');
process.stdout.write('Project invariants checked.\n');
