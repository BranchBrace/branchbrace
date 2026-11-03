import { createHash } from 'node:crypto';
import { open, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BranchBraceError } from './git.js';

// Mises à jour depuis les releases GitHub publiques du projet. Seule l'API des releases est contactée, sans identifiant
// ni donnée de dépôt, et uniquement sur demande (menu) ou si l'utilisateur a activé la vérification au démarrage.
// Canal « stable » : releases de `main` ; canal « beta » : s'y ajoutent les préversions publiées depuis `rc`.
export const REPOSITORY = 'BranchBrace/branchbrace';
export const CHANNELS = ['stable', 'beta'];
const RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=50`;
const RELEASE_PAGES = `https://github.com/${REPOSITORY}/releases/`;
const DOWNLOADS = `${RELEASE_PAGES}download/`;
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
// Un réseau filtré ou coupé ne doit pas laisser la recherche ou le téléchargement en suspens indéfiniment.
const CHECK_TIMEOUT = 15000;
const DOWNLOAD_IDLE_TIMEOUT = 30000;

export function parseVersion(text) {
  const match = VERSION.exec(String(text ?? '').trim());
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), prerelease: match[4] ? match[4].split('.') : [] };
}

// Précédence SemVer : 1.1.0-rc.2 < 1.1.0-rc.10 < 1.1.0 ; une préversion précède toujours la version finale.
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new BranchBraceError('invalid-version');
  for (let index = 0; index < 3; index += 1) if (a.core[index] !== b.core[index]) return Math.sign(a.core[index] - b.core[index]);
  if (!a.prerelease.length || !b.prerelease.length) return Math.sign(b.prerelease.length - a.prerelease.length);
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const [x, y] = [a.prerelease[index], b.prerelease[index]];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const [numericX, numericY] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (numericX && numericY) return Math.sign(Number(x) - Number(y));
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export const isPrerelease = (version) => Boolean(parseVersion(version)?.prerelease.length);

// Version la plus récente du canal parmi les releases renvoyées par l'API (brouillons et tags non SemVer ignorés).
export function selectRelease(releases, channel) {
  let best = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft || (channel !== 'beta' && release.prerelease)) continue;
    if (!parseVersion(release.tag_name)) continue;
    if (!best || compareVersions(release.tag_name, best.tag_name) > 0) best = release;
  }
  return best;
}

// Installateur téléchargeable pour cette plateforme et son empreinte publiée. Seul Windows en a un : ailleurs,
// la mise à jour passe par la page de la release. L'exécutable portable publié à côté n'est pas un installateur.
function installerOf(release, platform) {
  if (platform !== 'win32') return null;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const installer = assets.find((asset) => /setup.*\.exe$/i.test(asset.name) && String(asset.browser_download_url).startsWith(DOWNLOADS));
  const checksum = installer && assets.find((asset) => asset.name === `${installer.name}.sha256` && String(asset.browser_download_url).startsWith(DOWNLOADS));
  return checksum ? { name: installer.name, url: installer.browser_download_url, size: installer.size, checksumUrl: checksum.browser_download_url } : null;
}

export async function checkForUpdate({ currentVersion, channel, platform = process.platform, fetch = globalThis.fetch }) {
  if (!CHANNELS.includes(channel)) throw new BranchBraceError('invalid-update-channel');
  let releases;
  try {
    const response = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    releases = await response.json();
  } catch { throw new BranchBraceError('update-check-failed'); }
  const release = selectRelease(releases, channel);
  const latest = release && {
    version: release.tag_name.replace(/^v/, ''),
    prerelease: Boolean(release.prerelease),
    publishedAt: release.published_at || null,
    page: String(release.html_url).startsWith(RELEASE_PAGES) ? release.html_url : `${RELEASE_PAGES}tag/${encodeURIComponent(release.tag_name)}`,
    installer: installerOf(release, platform),
  };
  const available = Boolean(latest && parseVersion(currentVersion) && compareVersions(latest.version, currentVersion) > 0);
  return { channel, current: currentVersion, latest, available };
}

// Télécharge l'installateur dans `directory` et vérifie son SHA-256 contre l'empreinte publiée avec la release.
// Un fichier dont l'empreinte ne correspond pas est supprimé, jamais lancé.
// Le délai d'inactivité est réarmé à chaque bloc reçu : un téléchargement lent mais actif n'est pas interrompu.
export async function downloadInstaller(installer, directory, { fetch = globalThis.fetch, onProgress = () => {}, idleTimeout = DOWNLOAD_IDLE_TIMEOUT } = {}) {
  if (!installer?.url?.startsWith(DOWNLOADS) || !installer.checksumUrl?.startsWith(DOWNLOADS) || path.basename(installer.name) !== installer.name) {
    throw new BranchBraceError('update-download-failed');
  }
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, installer.name);
  const controller = new AbortController();
  let idle;
  const stillAlive = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), idleTimeout); };
  stillAlive();
  let expected;
  try {
    const checksum = await fetch(installer.checksumUrl, { signal: controller.signal });
    if (!checksum.ok) throw new Error(`HTTP ${checksum.status}`);
    expected = /^[0-9a-f]{64}/i.exec((await checksum.text()).trim())?.[0].toLowerCase();
    if (!expected) throw new Error('empreinte illisible');
    stillAlive();
    const response = await fetch(installer.url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || installer.size || 0;
    const hash = createHash('sha256');
    const file = await open(target, 'w');
    let received = 0;
    try {
      for await (const chunk of response.body) {
        stillAlive();
        hash.update(chunk);
        await file.write(chunk);
        received += chunk.length;
        onProgress({ received, total });
      }
    } finally { await file.close(); }
    if (hash.digest('hex') !== expected) {
      await rm(target, { force: true });
      throw new BranchBraceError('update-checksum-mismatch');
    }
  } catch (error) {
    await rm(target, { force: true });
    if (error instanceof BranchBraceError) throw error;
    throw new BranchBraceError('update-download-failed');
  } finally { clearTimeout(idle); }
  return target;
}

// Préférences de mise à jour. Sans choix enregistré, une version installée en préversion reste sur le canal bêta.
export async function readUpdateSettings(file, currentVersion) {
  const defaults = { channel: isPrerelease(currentVersion) ? 'beta' : 'stable', checkOnStartup: false };
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return {
      channel: CHANNELS.includes(data.channel) ? data.channel : defaults.channel,
      checkOnStartup: typeof data.checkOnStartup === 'boolean' ? data.checkOnStartup : defaults.checkOnStartup,
    };
  } catch { return defaults; }
}

export async function writeUpdateSettings(file, currentVersion, changes) {
  const settings = await readUpdateSettings(file, currentVersion);
  if (changes?.channel !== undefined) {
    if (!CHANNELS.includes(changes.channel)) throw new BranchBraceError('invalid-update-channel');
    settings.channel = changes.channel;
  }
  if (changes?.checkOnStartup !== undefined) settings.checkOnStartup = changes.checkOnStartup === true;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(settings, null, 2));
  return settings;
}
