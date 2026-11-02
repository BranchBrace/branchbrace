import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkForUpdate, compareVersions, downloadInstaller, readUpdateSettings, selectRelease, writeUpdateSettings } from '../src/updates.js';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const DOWNLOADS = 'https://github.com/BranchBrace/branchbrace/releases/download';

function release(tag, prerelease, extra = {}) {
  const name = `BranchBrace.Setup.${tag.slice(1)}.exe`;
  return {
    tag_name: tag,
    prerelease,
    draft: false,
    html_url: `https://github.com/BranchBrace/branchbrace/releases/tag/${tag}`,
    published_at: '2026-10-31T23:26:00Z',
    assets: [
      { name, size: 4, browser_download_url: `${DOWNLOADS}/${tag}/${name}` },
      { name: `${name}.sha256`, size: 100, browser_download_url: `${DOWNLOADS}/${tag}/${name}.sha256` },
    ],
    ...extra,
  };
}

const RELEASES = [
  release('v1.1.0-rc.2', true),
  release('v1.1.0-rc.10', true),
  release('v1.0.0', false),
  release('v0.9.0', false),
  release('v2.0.0', false, { draft: true }),
  release('nightly', true),
];

const respond = (routes) => async (url) => {
  const body = routes[url];
  if (body === undefined) return new Response('not found', { status: 404 });
  return new Response(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body), { status: 200 });
};

test('versions follow SemVer precedence, prereleases before their final release', () => {
  assert.equal(compareVersions('1.1.0-rc.2', '1.1.0-rc.10'), -1);
  assert.equal(compareVersions('1.1.0-rc.10', '1.1.0'), -1);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.6'), 1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-beta.1'), 1);
  assert.equal(compareVersions('1.0.0-rc', '1.0.0-rc.1'), -1);
});

test('the stable channel ignores prereleases; the beta channel takes the newest RC', () => {
  assert.equal(selectRelease(RELEASES, 'stable').tag_name, 'v1.0.0');
  assert.equal(selectRelease(RELEASES, 'beta').tag_name, 'v1.1.0-rc.10');
  assert.equal(selectRelease([release('v1.0.0', false), release('v1.0.0-rc.6', true)], 'beta').tag_name, 'v1.0.0');
  assert.equal(selectRelease([], 'stable'), null);
});

test('an update is offered only when the channel has a newer version', async () => {
  const fetch = respond({ 'https://api.github.com/repos/BranchBrace/branchbrace/releases?per_page=50': RELEASES });
  const stable = await checkForUpdate({ currentVersion: '1.0.0', channel: 'stable', platform: 'win32', fetch });
  assert.equal(stable.available, false);
  assert.equal(stable.latest.version, '1.0.0');

  const beta = await checkForUpdate({ currentVersion: '1.0.0', channel: 'beta', platform: 'win32', fetch });
  assert.equal(beta.available, true);
  assert.equal(beta.latest.version, '1.1.0-rc.10');
  assert.equal(beta.latest.prerelease, true);
  assert.equal(beta.latest.installer.name, 'BranchBrace.Setup.1.1.0-rc.10.exe');

  const fromRc = await checkForUpdate({ currentVersion: '1.0.0-rc.6', channel: 'stable', platform: 'win32', fetch });
  assert.equal(fromRc.available, true, 'a RC user switching to stable is offered the final release');

  const linux = await checkForUpdate({ currentVersion: '0.9.0', channel: 'stable', platform: 'linux', fetch });
  assert.equal(linux.available, true);
  assert.equal(linux.latest.installer, null, 'no installer outside Windows: the release page is opened instead');
  assert.equal(linux.latest.page, 'https://github.com/BranchBrace/branchbrace/releases/tag/v1.0.0');
});

test('installer assets hosted outside the project releases are never offered', async () => {
  const foreign = release('v1.2.0', false);
  foreign.assets[0].browser_download_url = 'https://example.com/BranchBrace.Setup.1.2.0.exe';
  const fetch = respond({ 'https://api.github.com/repos/BranchBrace/branchbrace/releases?per_page=50': [foreign] });
  const result = await checkForUpdate({ currentVersion: '1.0.0', channel: 'stable', platform: 'win32', fetch });
  assert.equal(result.available, true);
  assert.equal(result.latest.installer, null);
});

test('the portable executable published next to the installer is never taken for it', async () => {
  const both = release('v1.2.0', false);
  const portable = 'BranchBrace-1.2.0-portable.exe';
  both.assets.unshift(
    { name: portable, size: 4, browser_download_url: `${DOWNLOADS}/v1.2.0/${portable}` },
    { name: `${portable}.sha256`, size: 100, browser_download_url: `${DOWNLOADS}/v1.2.0/${portable}.sha256` },
  );
  const fetch = respond({ 'https://api.github.com/repos/BranchBrace/branchbrace/releases?per_page=50': [both] });
  const result = await checkForUpdate({ currentVersion: '1.0.0', channel: 'stable', platform: 'win32', fetch });
  assert.equal(result.latest.installer.name, 'BranchBrace.Setup.1.2.0.exe');
});

test('a GitHub outage is reported as an update check failure', async () => {
  const fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(checkForUpdate({ currentVersion: '1.0.0', channel: 'stable', fetch }), { code: 'update-check-failed' });
  await assert.rejects(checkForUpdate({ currentVersion: '1.0.0', channel: 'nightly', fetch }), { code: 'invalid-update-channel' });
});

test('the downloaded installer is kept only when it matches its published SHA-256', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gw-update-'));
  try {
    const content = new TextEncoder().encode('MZ..');
    const digest = createHash('sha256').update(content).digest('hex');
    const installer = {
      name: 'BranchBrace.Setup.1.1.0.exe',
      size: content.length,
      url: `${DOWNLOADS}/v1.1.0/BranchBrace.Setup.1.1.0.exe`,
      checksumUrl: `${DOWNLOADS}/v1.1.0/BranchBrace.Setup.1.1.0.exe.sha256`,
    };
    const progress = [];
    const file = await downloadInstaller(installer, directory, {
      fetch: respond({ [installer.url]: content, [installer.checksumUrl]: `${digest}  artifacts/BranchBrace Setup 1.1.0.exe\n` }),
      onProgress: (step) => progress.push(step),
    });
    assert.equal(await readFile(file, 'utf8'), 'MZ..');
    assert.deepEqual(progress.at(-1), { received: 4, total: 4 });

    await rm(file);
    await assert.rejects(downloadInstaller(installer, directory, {
      fetch: respond({ [installer.url]: content, [installer.checksumUrl]: `${'0'.repeat(64)}  x.exe` }),
    }), { code: 'update-checksum-mismatch' });
    assert.deepEqual(await readdir(directory), [], 'a mismatching installer is deleted');

    const stalled = async (url, { signal }) => (url === installer.checksumUrl
      ? new Response(`${digest}  x.exe`)
      : new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
    await assert.rejects(downloadInstaller(installer, directory, { fetch: stalled, idleTimeout: 50 }), { code: 'update-download-failed' });
    await assert.rejects(downloadInstaller({ ...installer, url: 'https://example.com/x.exe' }, directory, { fetch: respond({}) }), { code: 'update-download-failed' });
    await assert.rejects(downloadInstaller({ ...installer, name: '../x.exe' }, directory, { fetch: respond({}) }), { code: 'update-download-failed' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('update settings default to the channel of the installed version and are validated', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gw-settings-'));
  const file = path.join(directory, 'updates.json');
  try {
    assert.deepEqual(await readUpdateSettings(file, '1.0.0'), { channel: 'stable', checkOnStartup: false });
    assert.deepEqual(await readUpdateSettings(file, '1.1.0-rc.1'), { channel: 'beta', checkOnStartup: false });
    assert.deepEqual(await writeUpdateSettings(file, '1.0.0', { channel: 'beta' }), { channel: 'beta', checkOnStartup: false });
    assert.deepEqual(await writeUpdateSettings(file, '1.0.0', { checkOnStartup: true }), { channel: 'beta', checkOnStartup: true });
    await assert.rejects(writeUpdateSettings(file, '1.0.0', { channel: 'nightly' }), { code: 'invalid-update-channel' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the update module ships inside the packaged app', () => {
  assert.ok(manifest.build.files.includes('src/updates.js'));
});

test('the update found at startup does not replace the workbench update method', async () => {
  const renderer = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(renderer, /^ {2}update\(status, graph, refs\) \{/m, 'the workbench still refreshes its views through update()');
  assert.doesNotMatch(renderer, /\bui\.update\s*=[^=]/, 'assigning ui.update would break every repository opened afterwards');
});
