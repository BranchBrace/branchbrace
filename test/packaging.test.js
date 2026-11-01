import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

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
  const css = await readFile(new URL(stylesheet, entryPoint), 'utf8');
  assert.match(css, /\.topbar\s*\{/, 'the expected application styles are present');
});

test('every source module the main process loads is packaged into the app', async () => {
  const root = new URL('../', import.meta.url);
  const pending = ['electron/main.cjs'];
  const loaded = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    const source = await readFile(new URL(file, root), 'utf8');
    const specifiers = [
      ...source.matchAll(/require\('(\.[^']+)'\)/g),
      ...source.matchAll(/^import [^;]*? from '(\.[^']+)'/gm),
    ].map(([, specifier]) => new URL(specifier, new URL(file, root)).pathname.slice(root.pathname.length));
    for (const dependency of specifiers) {
      if (!loaded.has(dependency)) {
        loaded.add(dependency);
        pending.push(dependency);
      }
    }
  }

  for (const file of loaded) {
    if (file.startsWith('electron/')) continue;
    assert.ok(manifest.build.files.includes(file), `${file} is required at runtime but missing from build.files`);
  }
});

test('Linux x64 installer is a Debian package that declares the Git CLI dependency', () => {
  assert.deepEqual(manifest.build.linux.target, [{ target: 'deb', arch: ['x64'] }]);
  assert.ok(manifest.build.deb.depends.includes('git'), 'the app drives the installed Git CLI');
  assert.ok(manifest.build.linux.maintainer, 'dpkg needs a maintainer field');
});

test('installer packaging script is separate from the CI unpacked build', () => {
  assert.equal(manifest.scripts.build, 'vite build && electron-builder --dir');
  assert.equal(manifest.scripts['package:linux'], 'vite build && electron-builder --linux deb --x64');
});

test('installer smoke script exists and never touches the host package database', async () => {
  const script = await readFile(new URL('../scripts/smoke-linux-installer.sh', import.meta.url), 'utf8');
  assert.match(script, /docker run --rm/);
  assert.match(script, /debian:trixie/);
  assert.doesNotMatch(script, /\bsudo\b/);
});
