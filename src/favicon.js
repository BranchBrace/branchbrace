// Favicon d'un hébergeur Git qu'on ne reconnaît pas (GitLab auto-hébergé, Gitea…), montrée à côté de son dépôt
// distant. Seule l'adresse https://hôte/favicon.ico est demandée, sans cookie ni identifiant ; une réponse qui n'est
// pas une petite image est ignorée. Le résultat est une URL data:, affichable sans autre requête.
const MAX_BYTES = 64 * 1024;

export async function fetchFavicon(host, fetchImpl = fetch, timeout = 4000) {
  if (typeof host !== 'string' || !/^[a-z0-9.-]+$/i.test(host)) return null;
  try {
    const response = await fetchImpl(`https://${host}/favicon.ico`, { redirect: 'follow', signal: AbortSignal.timeout(timeout) });
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!response.ok || !type.startsWith('image/')) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_BYTES) return null;
    return `data:${type};base64,${bytes.toString('base64')}`;
  } catch { return null; }
}
