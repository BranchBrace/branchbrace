import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

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
