import { element, modal } from './dialogs.js';

// Nom et URL d'un dépôt distant. L'URL est vérifiée par le processus principal (identifiants refusés) : `error`
// réaffiche son refus dans le formulaire, sans perdre la saisie. `name: null` masque le champ du nom.
export function askRemote({ title, name = null, url = '', confirmLabel, error = '' }) {
  const input = (label, value) => {
    const field = element('label', 'dialog-field');
    const box = element('input', 'text-input');
    box.value = value;
    box.spellcheck = false;
    field.append(element('span', 'eyebrow', label), box);
    return { field, box };
  };
  const nameInput = name === null ? null : input('NOM', name);
  const urlInput = input('URL', url);
  const body = [...(nameInput ? [nameInput.field] : []), urlInput.field];
  body.push(element('p', 'dialog-hint', 'HTTPS sans identifiants (le credential helper du Git système les fournit) ou SSH, par exemple git@github.com:compte/depot.git.'));
  if (error) body.push(element('p', 'dialog-error', error));
  setTimeout(() => { const first = nameInput && !name ? nameInput.box : urlInput.box; first.focus(); first.select(); });
  return modal(title, body, {
    confirmLabel,
    collect: () => ({ name: nameInput ? nameInput.box.value.trim() : null, url: urlInput.box.value.trim() }),
    validate: (value) => ((nameInput && !value.name) || !value.url ? 'Le nom et l’URL sont requis.' : null),
  });
}
