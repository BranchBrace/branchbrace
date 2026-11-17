// Dialogues et menu contextuel dans la page : Electron n'implémente pas window.prompt.

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface ModalOptions<T> {
  confirmLabel?: string | undefined;
  cancelLabel?: string | null | undefined;
  collect: () => T;
  validate?: ((value: T) => string | null) | undefined;
}

// Ouvre une <dialog> modale construite à la volée ; `collect` lit la valeur au moment de la validation.
// `cancelLabel: null` retire le bouton Annuler (simple information à acquitter). Résout `null` si la fenêtre est fermée.
export function modal<T>(title: string, body: readonly (Node | string)[], { confirmLabel = 'Confirmer', cancelLabel = 'Annuler', collect, validate = () => null }: ModalOptions<T>): Promise<T | null> {
  return new Promise((resolve) => {
    const dialog = element('dialog', 'app-dialog');
    const form = element('form');
    form.method = 'dialog';
    const error = element('p', 'dialog-error');
    const confirm = element('button', 'button primary', confirmLabel); confirm.value = 'confirm'; confirm.type = 'submit';
    const actions = element('div', 'dialog-actions');
    if (cancelLabel) {
      const cancel = element('button', 'button secondary', cancelLabel); cancel.value = 'cancel'; cancel.type = 'button';
      cancel.addEventListener('click', () => dialog.close());
      actions.append(cancel);
    }
    actions.append(confirm);
    form.append(element('h2', '', title), ...body, error, actions);
    dialog.append(form);
    document.body.append(dialog);
    let result: T | null = null;
    form.addEventListener('submit', (event) => {
      const value = collect();
      const problem = validate(value);
      if (problem) { event.preventDefault(); error.textContent = problem; return; }
      result = value;
    });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
    dialog.showModal();
  });
}

export function askText({ title, label, value = '', confirmLabel, hint }: { title: string; label: string; value?: string; confirmLabel?: string; hint?: string }): Promise<string | null> {
  const input = element('input', 'text-input');
  input.value = value;
  input.spellcheck = false;
  const field = element('label', 'dialog-field');
  field.append(element('span', 'eyebrow', label), input);
  const body: HTMLElement[] = [field];
  if (hint) body.push(element('p', 'dialog-hint', hint));
  setTimeout(() => { input.focus(); input.select(); });
  return modal(title, body, { confirmLabel, collect: () => input.value.trim(), validate: (text) => (text ? null : 'Une valeur est requise.') });
}

// Renommage d'une branche : nouveau nom prérempli et, si elle a une distante, case (décochée) pour la renommer aussi.
export function askRename({ name, upstream }: { name: string; upstream?: string | null }): Promise<{ name: string; remote: boolean } | null> {
  const input = element('input', 'text-input');
  input.value = name;
  input.spellcheck = false;
  const field = element('label', 'dialog-field');
  field.append(element('span', 'eyebrow', 'NOUVEAU NOM'), input);
  const body: HTMLElement[] = [field, element('p', 'dialog-hint', 'Git refuse un nom déjà pris : aucune branche n’est remplacée. L’upstream suit la branche renommée.')];
  const remote = element('input');
  remote.type = 'checkbox';
  if (upstream) {
    const label = element('label', 'dialog-check');
    label.append(remote, ` Renommer aussi ${upstream} sur le dépôt distant (confirmation demandée)`);
    body.push(label);
  }
  setTimeout(() => { input.focus(); input.select(); });
  return modal(`Renommer « ${name} »`, body, {
    confirmLabel: 'Renommer',
    collect: () => ({ name: input.value.trim(), remote: remote.checked }),
    validate: (value) => (!value.name ? 'Un nom est requis.' : value.name === name ? 'Le nouveau nom est identique à l’actuel.' : null),
  });
}

// Nouvelle worktree : une branche existante libre (extraite nulle part) ou une nouvelle branche créée depuis `base`.
// Le dossier est choisi ensuite dans le dialogue natif.
export function askWorktree({ branches, base }: { branches: readonly string[]; base: string }): Promise<{ branch: string; newBranch: boolean } | null> {
  const select = element('select', 'text-input');
  const fresh = element('option', '', 'Nouvelle branche…');
  fresh.value = '';
  select.append(fresh, ...branches.map((name) => { const option = element('option', '', name); option.value = name; return option; }));
  const input = element('input', 'text-input');
  input.spellcheck = false;
  input.placeholder = 'nom de la nouvelle branche';
  const branchField = element('label', 'dialog-field');
  branchField.append(element('span', 'eyebrow', 'BRANCHE'), select);
  const nameField = element('label', 'dialog-field');
  nameField.append(element('span', 'eyebrow', 'NOUVELLE BRANCHE'), input);
  const hint = element('p', 'dialog-hint');
  const sync = () => {
    nameField.hidden = Boolean(select.value);
    hint.textContent = select.value
      ? `« ${select.value} » sera extraite dans la nouvelle worktree. Le dossier est choisi à l’étape suivante.`
      : `La branche sera créée depuis le HEAD de « ${base} ». Le dossier est choisi à l’étape suivante (un dossier non vide reçoit un sous-dossier au nom de la branche).`;
  };
  select.addEventListener('change', sync);
  sync();
  setTimeout(() => input.focus());
  return modal('Nouvelle worktree', [branchField, nameField, hint], {
    confirmLabel: 'Choisir le dossier…',
    collect: () => (select.value ? { branch: select.value, newBranch: false } : { branch: input.value.trim(), newBranch: true }),
    validate: (value) => (value.branch ? null : 'Un nom de branche est requis.'),
  });
}

// Menu contextuel unique : `items` est une liste de [libellé, action] ou de null pour un séparateur.
export type MenuItem = readonly [text: string, action: () => unknown, disabled?: boolean, shortcut?: string];
export type MenuEntry = MenuItem | null | undefined | false;
const menu = () => document.querySelector<HTMLElement>('#context-menu')!;
export function showMenu(items: readonly MenuEntry[], x: number, y: number): void {
  const container = menu();
  container.replaceChildren(...items.filter((item): item is MenuItem | null => item !== undefined && item !== false).map((item) => {
    if (item === null) return element('div', 'menu-separator');
    const [text, action, disabled, shortcut] = item;
    const button = element('button', 'menu-item', text);
    if (shortcut) button.append(element('span', 'menu-shortcut', shortcut));
    button.setAttribute('role', 'menuitem');
    button.disabled = Boolean(disabled);
    button.addEventListener('click', () => { hideMenu(); action(); });
    return button;
  }));
  container.hidden = false;
  container.style.left = `${Math.max(4, Math.min(x, window.innerWidth - container.offsetWidth - 8))}px`;
  container.style.top = `${Math.max(4, Math.min(y, window.innerHeight - container.offsetHeight - 8))}px`;
  container.querySelector<HTMLElement>('.menu-item:not(:disabled)')?.focus();
}
export function hideMenu(): void { menu().hidden = true; }

document.addEventListener('click', (event) => { if (!(event.target instanceof Element && event.target.closest('#context-menu'))) hideMenu(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideMenu(); });
window.addEventListener('blur', hideMenu);

// Confirmation d'une opération Git demandée par le processus principal : Annuler par défaut, Échap annule.
export function confirmDialog({ title, message }: { title: string; message: string }): Promise<boolean> {
  const body = element('p', 'dialog-message', message);
  return modal(title, [body], { confirmLabel: 'Confirmer', collect: () => true }).then((accepted) => accepted === true);
}

// Message à acquitter (refus d'une opération lancée par l'utilisateur) : un seul bouton OK.
export function alertDialog({ title, message }: { title: string; message: string }): Promise<true | null> {
  return modal(title, [element('p', 'dialog-message', message)], { confirmLabel: 'OK', cancelLabel: null, collect: () => true });
}

// Création d'un tag : annoté (message obligatoire) par défaut, léger si la case est décochée.
export function askTag({ target }: { target: string }): Promise<{ name: string; annotated: boolean; message: string } | null> {
  const name = element('input', 'text-input');
  name.spellcheck = false;
  const nameField = element('label', 'dialog-field');
  nameField.append(element('span', 'eyebrow', 'NOM DU TAG'), name);
  const annotated = element('input');
  annotated.type = 'checkbox';
  annotated.checked = true;
  const annotatedLabel = element('label', 'dialog-check');
  annotatedLabel.append(annotated, ' Tag annoté (auteur, date et message)');
  const message = element('textarea');
  message.rows = 3;
  const messageField = element('label', 'dialog-field');
  messageField.append(element('span', 'eyebrow', 'MESSAGE'), message);
  annotated.addEventListener('change', () => { messageField.hidden = !annotated.checked; });
  const hint = element('p', 'dialog-hint', `Le tag pointera sur ${target}. Il reste local tant qu’il n’est pas poussé.`);
  setTimeout(() => name.focus());
  return modal('Créer un tag', [nameField, annotatedLabel, messageField, hint], {
    confirmLabel: 'Créer',
    collect: () => ({ name: name.value.trim(), annotated: annotated.checked, message: message.value.trim() }),
    validate: (value) => (!value.name ? 'Un nom est requis.' : value.annotated && !value.message ? 'Un tag annoté demande un message.' : null),
  });
}

// Choix unique parmi `options` ([{ value, label }]) ; la première est présélectionnée.
export function askChoice<V>({ title, message, options, confirmLabel }: { title: string; message: string; options: readonly { value: V; label: string }[]; confirmLabel?: string }): Promise<V | null> {
  const group = `choice-${Date.now()}`;
  const inputs = options.map((option, index) => {
    const input = element('input');
    input.type = 'radio';
    input.name = group;
    input.checked = index === 0;
    const label = element('label', 'dialog-check');
    label.append(input, ` ${option.label}`);
    return { input, label, value: option.value };
  });
  return modal(title, [element('p', 'dialog-message', message), ...inputs.map((item) => item.label)], {
    confirmLabel,
    collect: () => inputs.find((item) => item.input.checked)?.value ?? null,
  });
}
