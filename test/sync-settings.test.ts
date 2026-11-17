import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readSyncSettings, writeSyncSettings } from '../src/sync-settings.ts';

async function settingsFile(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'branchbrace-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, 'nested', 'sync.json');
}

test('automatic fetch is enabled every 5 minutes by default', async (t) => {
  assert.deepEqual(await readSyncSettings(await settingsFile(t)), { autoFetch: true, intervalMinutes: 5 });
});

test('automatic fetch settings persist and reject unknown intervals', async (t) => {
  const file = await settingsFile(t);
  assert.deepEqual(await writeSyncSettings(file, { autoFetch: false, intervalMinutes: 15 }), { autoFetch: false, intervalMinutes: 15 });
  assert.deepEqual(await readSyncSettings(file), { autoFetch: false, intervalMinutes: 15 });
  await assert.rejects(writeSyncSettings(file, { intervalMinutes: 0 }), { code: 'invalid-fetch-interval' });
  await writeFile(file, JSON.stringify({ autoFetch: 'yes', intervalMinutes: 7 }));
  assert.deepEqual(await readSyncSettings(file), { autoFetch: true, intervalMinutes: 5 });
});
