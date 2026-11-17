import { element, modal } from './dialogs.ts';
import { COMMIT_TYPES, formatHeader, parseHeader, withBreakingFooter } from './conventional.ts';

// Assistant Conventional Commits : type, portée (proposée d'après l'historique), rupture d'API et description, avec
// l'aperçu exact du résumé. Le message existant est relu pour préremplir les champs.
export function composeConventional({ summary, description, scopes }: { summary: string; description: string; scopes: readonly string[] }) {
  const parsed = parseHeader(summary);
  const breakingNote = /^BREAKING CHANGE: ([\s\S]*)$/m.exec(description || '')?.[1] || '';
  const state = { type: parsed.type || 'feat', scope: parsed.scope, breaking: parsed.breaking || Boolean(breakingNote), subject: parsed.subject };

  const types = element('div', 'cc-types');
  const typeButtons = COMMIT_TYPES.map(([type, label, icon]) => {
    const button = element('button', 'cc-type');
    button.type = 'button';
    button.append(element('span', 'cc-type-icon', icon), element('strong', '', type), element('span', 'cc-type-label', label));
    button.addEventListener('click', () => { state.type = type; update(); subject.focus(); });
    types.append(button);
    return [type, button] as const;
  });

  const scope = element('input', 'text-input');
  scope.placeholder = 'optionnelle — ex. ui, git, editor';
  scope.value = state.scope;
  scope.spellcheck = false;
  scope.setAttribute('list', 'cc-scopes');
  const list = element('datalist');
  list.id = 'cc-scopes';
  for (const known of scopes) { const option = element('option'); option.value = known; list.append(option); }
  const scopeChips = element('div', 'cc-scope-chips');
  for (const known of scopes.slice(0, 8)) {
    const chip = element('button', 'chip-toggle', known);
    chip.type = 'button';
    chip.addEventListener('click', () => { scope.value = scope.value === known ? '' : known; update(); });
    scopeChips.append(chip);
  }

  const subject = element('input', 'text-input');
  subject.placeholder = 'description à l’impératif — ex. ajoute la résolution des conflits';
  subject.value = state.subject;

  const breaking = element('input');
  breaking.type = 'checkbox';
  breaking.checked = state.breaking;
  const breakingLabel = element('label', 'cc-breaking');
  breakingLabel.append(breaking, ' Changement cassant (', element('code', '', '!'), ' + pied ', element('code', '', 'BREAKING CHANGE'), ')');
  const note = element('textarea', 'cc-note');
  note.rows = 2;
  note.placeholder = 'Ce qui casse et comment migrer';
  note.value = breakingNote;

  const preview = element('div', 'cc-preview');
  const field = (label: string, ...nodes: Node[]) => { const wrapper = element('label', 'dialog-field'); wrapper.append(element('span', 'eyebrow', label), ...nodes); return wrapper; };

  function update() {
    state.scope = scope.value;
    state.subject = subject.value;
    state.breaking = breaking.checked;
    for (const [type, button] of typeButtons) button.classList.toggle('active', type === state.type);
    note.hidden = !state.breaking;
    const header = formatHeader(state);
    preview.replaceChildren(element('span', 'eyebrow', 'APERÇU'), element('code', `cc-header${header.length > 72 ? ' over' : ''}`, header), element('span', 'cc-length', `${header.length}/72`));
  }
  for (const input of [scope, subject, breaking, note]) input.addEventListener('input', update);
  breaking.addEventListener('change', update);
  update();
  setTimeout(() => subject.focus());

  return modal('Conventional Commit', [types, field('PORTÉE', scope, list, scopeChips), field('DESCRIPTION', subject), breakingLabel, note, preview], {
    confirmLabel: 'Appliquer au message',
    collect: () => ({
      summary: formatHeader(state),
      description: withBreakingFooter(description, state.breaking ? note.value : ''),
    }),
    validate: () => (state.subject.trim() ? null : 'La description est requise.'),
  });
}
