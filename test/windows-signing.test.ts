import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

interface SigningConfig {
  jar: string;
  storetype: string;
  keystore: string;
  alias: string;
  storepass: string | null;
}
interface Signer {
  signingConfig(env?: Record<string, string | undefined>): SigningConfig | null;
  jsignArgs(file: string, config: SigningConfig): string[];
}
interface Manifest {
  build: { win: { signtoolOptions: { sign: string; signingHashAlgorithms: string[] } } };
}

const require = createRequire(import.meta.url);
const signer = require('../scripts/sign-windows.cts') as Signer;
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Manifest;

const artifactSigning = {
  JSIGN_JAR: '/project/.cache/jsign/jsign.jar',
  WINDOWS_SIGNING_KEYSTORE: 'weu.codesigning.azure.net',
  WINDOWS_SIGNING_ALIAS: 'monnier/git-workbench',
  WINDOWS_SIGNING_STOREPASS: 'access-token',
};

test('electron-builder delegates every Windows signature to the jsign hook, SHA-256 only', () => {
  assert.equal(manifest.build.win.signtoolOptions.sign, './out/scripts/sign-windows.cjs');
  assert.deepEqual(manifest.build.win.signtoolOptions.signingHashAlgorithms, ['sha256']);
});

test('signing is skipped when no keystore is configured', () => {
  assert.equal(signer.signingConfig({}), null);
});

test('a release that requires signing fails instead of shipping an unsigned installer', () => {
  assert.throws(() => signer.signingConfig({ WINDOWS_SIGNING_REQUIRED: '1' }), /WINDOWS_SIGNING_KEYSTORE/);
});

test('Azure Artifact Signing is the default store type', () => {
  const config = signer.signingConfig(artifactSigning);
  assert.ok(config);
  assert.equal(config.storetype, 'TRUSTEDSIGNING');
  assert.deepEqual(signer.jsignArgs('C:/out/Setup.exe', config), [
    '-jar', '/project/.cache/jsign/jsign.jar',
    '--storetype', 'TRUSTEDSIGNING',
    '--keystore', 'weu.codesigning.azure.net',
    '--alias', 'monnier/git-workbench',
    '--storepass', 'access-token',
    'C:/out/Setup.exe',
  ]);
});

test('without an access token jsign reads the Azure credentials from the environment', () => {
  const { WINDOWS_SIGNING_STOREPASS, ...env } = artifactSigning;
  assert.ok(!signer.jsignArgs('a.exe', signer.signingConfig(env)!).includes('--storepass'));
});

test('a configured keystore without alias or jsign jar is rejected', () => {
  assert.throws(() => signer.signingConfig({ ...artifactSigning, WINDOWS_SIGNING_ALIAS: '' }), /WINDOWS_SIGNING_ALIAS/);
  assert.throws(() => signer.signingConfig({ ...artifactSigning, JSIGN_JAR: '' }), /JSIGN_JAR/);
});

test('the release script pins the jsign download and verifies its checksum', async () => {
  const script = await readFile(new URL('../scripts/package-windows-release.sh', import.meta.url), 'utf8');
  assert.match(script, /repo1\.maven\.org\/maven2\/net\/jsign\/jsign\//);
  assert.match(script, /sha256sum -c/);
  assert.doesNotMatch(script, /WINDOWS_SIGNING_STOREPASS=/, 'the token must never appear on a command line');
});
