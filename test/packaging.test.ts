import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

interface Manifest {
  main: string;
  scripts: Record<string, string>;
  build: { files: string[]; linux: { target: unknown; maintainer?: string }; deb: { depends: string[] }; win: { signtoolOptions: { sign: string } } };
}
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Manifest;

test('built renderer assets resolve beside the packaged file-based entry point', async () => {
  const entryPoint = new URL('../dist/index.html', import.meta.url);
  const html = await readFile(entryPoint, 'utf8');
  const references = [
    ...html.matchAll(/<script[^>]+src="([^"]+)"/g),
    ...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g),
  ].map(([, reference]) => reference);

  assert.ok(references.some((reference) => reference.endsWith('.css')), 'built HTML references a stylesheet');
  assert.ok(references.some((reference) => reference.endsWith('.js')), 'built HTML references its application module');
  for (const reference of references) {
    assert.ok(!reference.startsWith('/'), `asset path must be relative to the file entry point: ${reference}`);
    await access(fileURLToPath(new URL(reference, entryPoint)));
  }

  const stylesheet = references.find((reference) => reference.endsWith('.css'));
  const css = await readFile(new URL(stylesheet!, entryPoint), 'utf8');
  assert.match(css, /\.topbar\s*\{/, 'the expected application styles are present');
});

// Chemin de la version compilée par tsconfig.main.json (rootDir « . », outDir « out »).
const compiled = (file: string) => `out/${file.replace(/\.ts$/, '.js').replace(/\.cts$/, '.cjs').replace(/\.mts$/, '.mjs')}`;
const packaged = (file: string) => manifest.build.files.some((pattern) => pattern === file || (pattern.endsWith('/**/*') && file.startsWith(pattern.slice(0, -4))));

test('every source module the main process loads is compiled and packaged into the app', async () => {
  const root = new URL('../', import.meta.url);
  const tsconfig = JSON.parse((await readFile(new URL('tsconfig.main.json', root), 'utf8')).replace(/^\s*\/\/.*$/gm, '')) as { compilerOptions: { outDir: string }; files: string[] };
  assert.equal(tsconfig.compilerOptions.outDir, 'out');
  assert.equal(manifest.main, compiled('electron/main.cts'), 'Electron starts the compiled main process');

  const pending = [...tsconfig.files];
  const loaded = new Set<string>(pending);
  while (pending.length > 0) {
    const file = pending.pop()!;
    const source = await readFile(new URL(file, root), 'utf8');
    // Les imports de types disparaissent à la compilation : seuls les autres sont chargés à l'exécution. Les require()
    // des fichiers .cts visent déjà le nom compilé (.js), ramené ici à sa source .ts.
    const specifiers = [
      ...source.matchAll(/^import (?!type )[^;]*? from '(\.[^']+)'/gm),
      ...source.matchAll(/\brequire\('(\.[^']+)'\)/g),
    ].map(([, specifier]) => new URL(specifier.replace(/\.js$/, '.ts'), new URL(file, root)).pathname.slice(root.pathname.length));
    for (const dependency of specifiers) {
      if (!loaded.has(dependency)) {
        loaded.add(dependency);
        pending.push(dependency);
      }
    }
  }

  assert.ok(loaded.has('src/git.ts'), 'the dependency walk reaches the Git service');
  for (const file of loaded) {
    if (file === 'scripts/sign-windows.cts') continue;
    assert.ok(packaged(compiled(file)), `${compiled(file)} is required at runtime but missing from build.files`);
  }
  assert.equal(manifest.build.win.signtoolOptions.sign, `./${compiled('scripts/sign-windows.cts')}`);
});

test('Linux x64 installer is a Debian package that declares the Git CLI dependency', () => {
  assert.deepEqual(manifest.build.linux.target, [{ target: 'deb', arch: ['x64'] }]);
  assert.ok(manifest.build.deb.depends.includes('git'), 'the app drives the installed Git CLI');
  assert.ok(manifest.build.linux.maintainer, 'dpkg needs a maintainer field');
});

test('installer packaging script is separate from the CI unpacked build', () => {
  assert.equal(manifest.scripts['build:app'], 'vite build && tsc -p tsconfig.main.json');
  assert.equal(manifest.scripts.build, 'npm run build:app && electron-builder --dir');
  assert.equal(manifest.scripts['package:linux'], 'npm run build:app && electron-builder --linux deb --x64');
});

test('installer smoke script exists and never touches the host package database', async () => {
  const script = await readFile(new URL('../scripts/smoke-linux-installer.sh', import.meta.url), 'utf8');
  assert.match(script, /docker run --rm/);
  assert.match(script, /debian:trixie/);
  assert.doesNotMatch(script, /\bsudo\b/);
});
