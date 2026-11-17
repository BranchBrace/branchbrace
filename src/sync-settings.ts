import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BranchBraceError } from './git.ts';

// Fetch automatique : toutes les N minutes, à l'ouverture d'un dépôt et au retour sur la fenêtre. Activé par défaut
// toutes les 5 minutes ; il ne met à jour que les branches distantes, jamais la branche courante (le pull reste un clic).
export const FETCH_INTERVALS: readonly number[] = [1, 2, 5, 10, 15, 30, 60];
const DEFAULTS: SyncSettings = { autoFetch: true, intervalMinutes: 5 };

export interface SyncSettings {
  autoFetch: boolean;
  intervalMinutes: number;
}

// Modification demandée par la page : valeurs non vérifiées, d'où `unknown`.
export interface SyncSettingsChanges {
  autoFetch?: unknown;
  intervalMinutes?: unknown;
}

const isInterval = (value: unknown): value is number => typeof value === 'number' && FETCH_INTERVALS.includes(value);

export async function readSyncSettings(file: string): Promise<SyncSettings> {
  try {
    const record = JSON.parse(await readFile(file, 'utf8')) as Partial<Record<keyof SyncSettings, unknown>>;
    return {
      autoFetch: typeof record.autoFetch === 'boolean' ? record.autoFetch : DEFAULTS.autoFetch,
      intervalMinutes: isInterval(record.intervalMinutes) ? record.intervalMinutes : DEFAULTS.intervalMinutes,
    };
  } catch { return { ...DEFAULTS }; }
}

export async function writeSyncSettings(file: string, changes?: SyncSettingsChanges | null): Promise<SyncSettings> {
  const settings = await readSyncSettings(file);
  if (changes?.intervalMinutes !== undefined) {
    if (!isInterval(changes.intervalMinutes)) throw new BranchBraceError('invalid-fetch-interval');
    settings.intervalMinutes = changes.intervalMinutes;
  }
  if (changes?.autoFetch !== undefined) settings.autoFetch = changes.autoFetch === true;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(settings, null, 2));
  return settings;
}
