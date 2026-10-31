// Dialogues et menu contextuel dans la page : Electron n'implémente pas window.prompt.

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Ouvre une <dialog> modale construite à la volée ; `collect` lit la valeur au moment de la validation.
// `cancelLabel: null` retire le bouton Annuler (simple information à acquitter).
function modal(title, body, { confirmLabel = 'Confirmer', cancelLabel = 'Annuler', collect, validate = () => null }) {
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
    let result = null;
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

export function askText({ title, label, value = '', confirmLabel, hint }) {
  const input = element('input', 'text-input');
  input.value = value;
  input.spellcheck = false;
  const field = element('label', 'dialog-field');
  field.append(element('span', 'eyebrow', label), input);
  const body = [field];
  if (hint) body.push(element('p', 'dialog-hint', hint));
  setTimeout(() => { input.focus(); input.select(); });
  return modal(title, body, { confirmLabel, collect: () => input.value.trim(), validate: (text) => (text ? null : 'Une valeur est requise.') });
}

// Plan de rebase interactif, du plus ancien au plus récent : action par commit et réordonnancement.
export function editRebasePlan({ base, branch, commits }) {
  const plan = commits.map((commit) => ({ ...commit, action: 'pick' }));
  const list = element('ol', 'rebase-plan');
  const render = () => {
    list.replaceChildren(...plan.map((item, index) => {
      const row = element('li', `rebase-step action-${item.action}`);
      const select = element('select', 'rebase-action');
      for (const [value, text] of [['pick', 'Garder'], ['fixup', 'Fusionner dans le précédent'], ['drop', 'Écarter']]) {
        const option = element('option', '', text); option.value = value; option.selected = item.action === value; select.append(option);
      }
      select.addEventListener('change', () => { item.action = select.value; render(); });
      const move = (offset) => { const target = index + offset; if (target < 0 || target >= plan.length) return; [plan[index], plan[target]] = [plan[target], plan[index]]; render(); };
      const up = element('button', 'icon-button small', '↑'); up.type = 'button'; up.disabled = index === 0; up.title = 'Monter'; up.addEventListener('click', () => move(-1));
      const down = element('button', 'icon-button small', '↓'); down.type = 'button'; down.disabled = index === plan.length - 1; down.title = 'Descendre'; down.addEventListener('click', () => move(1));
      const label = element('span', 'rebase-subject');
      label.append(element('code', '', item.shortHash), ' ', item.subject);
      row.append(select, label, up, down);
      return row;
    }));
  };
  render();
  const intro = element('p', 'dialog-hint', `Commits de « ${branch} » rejoués sur ${base}, du plus ancien (en haut) au plus récent.`);
  return modal('Rebase interactif', [intro, list], {
    confirmLabel: 'Vérifier le plan',
    collect: () => plan.map(({ hash, action }) => ({ hash, action })),
    validate: (steps) => {
      let previousKept = false;
      for (const step of steps) {
        if (step.action === 'fixup' && !previousKept) return 'Un commit fusionné doit suivre un commit gardé.';
        previousKept = step.action !== 'drop';
      }
      return steps.every((step) => step.action === 'drop') ? 'Le plan écarterait tous les commits.' : null;
    },
  });
}

// Menu contextuel unique : `items` est une liste de [libellé, action] ou de null pour un séparateur.
const menu = () => document.querySelector('#context-menu');
export function showMenu(items, x, y) {
  const container = menu();
  container.replaceChildren(...items.filter((item) => item !== undefined && item !== false).map((item) => {
    if (item === null) return element('div', 'menu-separator');
    const [text, action, disabled] = item;
    const button = element('button', 'menu-item', text);
    button.setAttribute('role', 'menuitem');
    button.disabled = Boolean(disabled);
    button.addEventListener('click', () => { hideMenu(); action(); });
    return button;
  }));
  container.hidden = false;
  container.style.left = `${Math.max(4, Math.min(x, window.innerWidth - container.offsetWidth - 8))}px`;
  container.style.top = `${Math.max(4, Math.min(y, window.innerHeight - container.offsetHeight - 8))}px`;
  container.querySelector('.menu-item:not(:disabled)')?.focus();
}
export function hideMenu() { menu().hidden = true; }

document.addEventListener('click', (event) => { if (!event.target.closest('#context-menu')) hideMenu(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideMenu(); });
window.addEventListener('blur', hideMenu);

// Confirmation d'une opération Git demandée par le processus principal : Annuler par défaut, Échap annule.
export function confirmDialog({ title, message }) {
  const body = element('p', 'dialog-message', message);
  return modal(title, [body], { confirmLabel: 'Confirmer', collect: () => true }).then((accepted) => accepted === true);
}

// Message à acquitter (refus d'une opération lancée par l'utilisateur) : un seul bouton OK.
export function alertDialog({ title, message }) {
  return modal(title, [element('p', 'dialog-message', message)], { confirmLabel: 'OK', cancelLabel: null, collect: () => true });
}
