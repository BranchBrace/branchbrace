import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GitWorkbenchError } from './git.js';

// Fetch automatique : toutes les N minutes, à l'ouverture d'un dépôt et au retour sur la fenêtre. Activé par défaut
// toutes les 5 minutes ; il ne met à jour que les branches distantes, jamais la branche courante (le pull reste un clic).
export const FETCH_INTERVALS = [1, 2, 5, 10, 15, 30, 60];
const DEFAULTS = { autoFetch: true, intervalMinutes: 5 };

export async function readSyncSettings(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return {
      autoFetch: typeof data.autoFetch === 'boolean' ? data.autoFetch : DEFAULTS.autoFetch,
      intervalMinutes: FETCH_INTERVALS.includes(data.intervalMinutes) ? data.intervalMinutes : DEFAULTS.intervalMinutes,
    };
  } catch { return { ...DEFAULTS }; }
}

export async function writeSyncSettings(file, changes) {
  const settings = await readSyncSettings(file);
  if (changes?.intervalMinutes !== undefined) {
    if (!FETCH_INTERVALS.includes(changes.intervalMinutes)) throw new GitWorkbenchError('invalid-fetch-interval');
    settings.intervalMinutes = changes.intervalMinutes;
  }
  if (changes?.autoFetch !== undefined) settings.autoFetch = changes.autoFetch === true;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(settings, null, 2));
  return settings;
}
