import { element, modal } from './dialogs.js';
import { describeError } from './errors.js';

const CHANNEL_LABELS = { stable: 'Stable — versions publiées depuis main', beta: 'Bêta — inclut les préversions (RC)' };
const megabytes = (bytes) => `${(bytes / 1048576).toFixed(1)} Mo`;
// Un seul écouteur IPC pour toute la session : il alimente la fenêtre ouverte, s'il y en a une.
let showProgress = () => {};
window.workbench.onUpdateProgress((progress) => showProgress(progress));

// Fenêtre « Mises à jour » : canal, vérification au démarrage, recherche et installation. Le choix du canal est
// enregistré aussitôt ; la recherche n'a lieu que sur clic (ou, à l'ouverture, si `check` est vrai).
export async function openUpdates({ check = false, onResult = () => {} } = {}) {
  const settings = await window.workbench.updateSettings();

  const channel = element('select');
  for (const [value, label] of Object.entries(CHANNEL_LABELS)) {
    const option = element('option', '', label);
    option.value = value;
    channel.append(option);
  }
  channel.value = settings.channel;
  const channelField = element('label', 'dialog-field');
  channelField.append(element('span', 'eyebrow', 'CANAL'), channel);

  const startup = element('input');
  startup.type = 'checkbox';
  startup.checked = settings.checkOnStartup;
  const startupLabel = element('label', 'update-startup');
  startupLabel.append(startup, ' Rechercher les mises à jour au démarrage');

  const result = element('div', 'update-result');
  const search = element('button', 'button secondary', 'Rechercher maintenant');
  search.type = 'button';
  const install = element('button', 'button primary', '');
  install.type = 'button';
  install.hidden = true;
  const row = element('div', 'update-actions');
  row.append(search, install);

  const hint = element('p', 'dialog-hint', 'La recherche interroge uniquement l’API publique des releases GitHub du projet. Aucune donnée de vos dépôts n’est transmise.');

  const show = (text, tone = '') => { result.className = `update-result ${tone}`; result.textContent = text; };
  show(`Version installée : ${settings.current}`);

  async function run() {
    search.disabled = true;
    install.hidden = true;
    show('Recherche en cours…');
    try {
      const found = await window.workbench.checkForUpdate(channel.value);
      onResult(found);
      if (!found.latest) show(`Aucune release publiée sur ce canal. Version installée : ${found.current}.`);
      else if (!found.available) show(`BranchBrace ${found.current} est à jour (dernière version du canal : ${found.latest.version}).`, 'ok');
      else {
        const date = found.latest.publishedAt ? ` le ${new Date(found.latest.publishedAt).toLocaleDateString('fr-FR')}` : '';
        show(`Version ${found.latest.version}${found.latest.prerelease ? ' (préversion)' : ''} disponible, publiée${date}. Version installée : ${found.current}.`, 'available');
        install.textContent = settings.installable && found.latest.installer ? `Installer ${found.latest.version}` : 'Ouvrir la page de la release';
        install.hidden = false;
      }
    } catch (error) { show(describeError(error), 'error'); }
    finally { search.disabled = false; }
  }

  channel.addEventListener('change', async () => {
    install.hidden = true;
    try { await window.workbench.setUpdateSettings({ channel: channel.value }); await run(); }
    catch (error) { show(describeError(error), 'error'); }
  });
  startup.addEventListener('change', () => window.workbench.setUpdateSettings({ checkOnStartup: startup.checked }).catch((error) => show(describeError(error), 'error')));
  search.addEventListener('click', run);
  install.addEventListener('click', async () => {
    install.disabled = search.disabled = channel.disabled = true;
    try {
      const outcome = await window.workbench.installUpdate();
      if (outcome?.installing) show(`Lancement de l’installateur ${outcome.installing}… BranchBrace va se fermer.`, 'ok');
      else if (outcome?.opened) show('Page de la release ouverte dans le navigateur.', 'ok');
    } catch (error) { show(describeError(error), 'error'); }
    finally { install.disabled = search.disabled = channel.disabled = false; }
  });
  showProgress = ({ received, total }) => {
    if (!result.isConnected) return;
    show(total ? `Téléchargement : ${megabytes(received)} / ${megabytes(total)} (${Math.floor((received / total) * 100)} %)` : `Téléchargement : ${megabytes(received)}`);
  };

  if (check) run();
  return modal('Mises à jour', [channelField, startupLabel, row, result, hint], { confirmLabel: 'Fermer', cancelLabel: null, collect: () => true });
}

// Vérification silencieuse au démarrage, seulement si l'utilisateur l'a activée. Un échec (hors ligne…) est ignoré.
export async function checkOnStartup() {
  try {
    const settings = await window.workbench.updateSettings();
    if (!settings.checkOnStartup) return null;
    return await window.workbench.checkForUpdate(settings.channel);
  } catch { return null; }
}
