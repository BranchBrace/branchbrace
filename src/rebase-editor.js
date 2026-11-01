// Éditeur de rebase interactif : chaque commit de la branche (du plus ancien, en haut, au plus récent) reçoit une
// action choisie dans un menu coloré, se déplace en glissant la ligne (ou Alt+↑/↓), et l'aperçu montre l'historique
// obtenu avant de lancer quoi que ce soit. Raccourcis sur la ligne active : P garder, R reformuler, C découper,
// S fusionner, F absorber, D écarter.
const ACTIONS = [
  { id: 'pick', label: 'Garder', key: 'P', hint: 'Garder le commit tel quel' },
  { id: 'reword', label: 'Reformuler', key: 'R', hint: 'Garder le commit en changeant son message' },
  { id: 'split', label: 'Découper', key: 'C', hint: 'S’arrêter sur ce commit pour le recommitter en plusieurs morceaux' },
  { id: 'squash', label: 'Fusionner', key: 'S', hint: 'Fusionner dans le commit au-dessus, messages combinés' },
  { id: 'fixup', label: 'Absorber', key: 'F', hint: 'Fusionner dans le commit au-dessus en gardant son message à lui' },
  { id: 'drop', label: 'Écarter', key: 'D', hint: 'Retirer ce commit de la branche' },
];
const ACTION = Object.fromEntries(ACTIONS.map((action) => [action.id, action]));
const KEYS = Object.fromEntries(ACTIONS.map((action) => [action.key.toLowerCase(), action.id]));
// Pictogrammes 16×16 tracés au trait : coche, crayon, ciseaux, double chevron (fusion), chevron sous une barre
// (absorption), croix.
const ICONS = {
  pick: '<path d="M3.5 8.5l3 3 6-7"/>',
  reword: '<path d="M10.5 3l2.5 2.5L6 12.5H3.5V10z"/><path d="M9 4.5l2.5 2.5"/>',
  split: '<circle cx="4.5" cy="11.5" r="2"/><circle cx="11.5" cy="11.5" r="2"/><path d="M6 10L12 3"/><path d="M10 10L4 3"/>',
  squash: '<path d="M4 8.5l4-4 4 4"/><path d="M4 12.5l4-4 4 4"/>',
  fixup: '<path d="M3 3h10"/><path d="M4.5 10.5L8 7l3.5 3.5"/><path d="M8 7v6.5"/>',
  drop: '<path d="M4.5 4.5l7 7"/><path d="M11.5 4.5l-7 7"/>',
};
const GRIP = '<svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>';
const GAP = 8;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(action) {
  const chip = element('span', `rebase-icon icon-${action}`);
  chip.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[action]}</svg>`;
  return chip;
}

const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('') || '?';
const hue = (text) => [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
const when = (timestamp) => new Date(timestamp * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

// Groupes du résultat : un commit gardé suivi des commits qui s'y fusionnent.
function groups(plan) {
  const result = [];
  for (const item of plan) {
    if (item.action === 'drop') continue;
    if ((item.action === 'squash' || item.action === 'fixup') && result.length) result.at(-1).members.push(item);
    else result.push({ head: item, members: [] });
  }
  return result;
}

// Message par défaut d'un groupe fusionné : celui du commit de tête puis ceux des « squash », comme Git le propose.
const defaultGroupMessage = (group) => [group.head.message, ...group.members.filter((item) => item.action === 'squash').map((item) => item.message)].join('\n\n');

export function validatePlan(plan, messageOf = defaultGroupMessage) {
  let kept = false;
  for (const item of plan) {
    if ((item.action === 'squash' || item.action === 'fixup') && !kept) return `« ${item.subject} » ne peut pas fusionner : aucun commit gardé au-dessus de lui.`;
    if (item.action !== 'drop') kept = true;
    if (item.action === 'reword' && !item.draft.trim()) return `Le nouveau message de « ${item.subject} » est vide.`;
  }
  if (!kept) return 'Le plan écarterait tous les commits : la branche reviendrait à la base.';
  for (const group of groups(plan)) if (group.members.some((item) => item.action === 'squash') && !messageOf(group).trim()) return `Le message du commit fusionné « ${group.head.subject} » est vide.`;
  return null;
}

export function editRebasePlan({ base, branch, commits }) {
  return new Promise((resolve) => {
    const plan = commits.map((commit) => ({ ...commit, action: 'pick', draft: commit.message }));
    const groupMessages = new Map();
    let menu = null;

    const dialog = element('dialog', 'app-dialog rebase-dialog');
    const header = element('div', 'rebase-header');
    const title = element('h2', '', 'Rebase interactif');
    const subtitle = element('p', 'dialog-hint');
    subtitle.append(element('span', 'branch-chip', branch), ` · ${commits.length} commit${commits.length > 1 ? 's' : ''} rejoué${commits.length > 1 ? 's' : ''} sur `, element('code', 'sha-chip', base), ' · du plus ancien (en haut) au plus récent');
    const legend = element('div', 'rebase-legend');
    for (const action of ACTIONS) {
      const entry = element('span', `rebase-legend-item action-${action.id}`);
      entry.append(icon(action.id), element('kbd', '', action.key), ` ${action.label}`);
      entry.title = action.hint;
      legend.append(entry);
    }
    legend.append(element('span', 'rebase-legend-tip', 'Glisser une ligne pour la déplacer · Alt+↑/↓ · double-clic sur un message pour le reformuler'));
    header.append(title, subtitle, legend);
    const body = element('div', 'rebase-body');
    const list = element('ol', 'rebase-plan');
    const preview = element('aside', 'rebase-preview');
    body.append(list, preview);
    const error = element('p', 'dialog-error');
    const actions = element('div', 'dialog-actions');
    const reset = element('button', 'button secondary', 'Tout réinitialiser');
    const cancel = element('button', 'button secondary', 'Annuler');
    const confirm = element('button', 'button primary', 'Lancer le rebase');
    reset.style.marginRight = 'auto';
    actions.append(reset, cancel, confirm);
    dialog.append(header, body, error, actions);
    document.body.append(dialog);

    const groupOf = (item) => groups(plan).find((group) => group.head === item || group.members.includes(item));
    const messageOf = (group) => groupMessages.get(group.head.hash) ?? defaultGroupMessage(group);

    const closeMenu = () => { menu?.node.remove(); menu = null; };
    const setAction = (index, action) => {
      closeMenu();
      plan[index].action = action;
      render();
      list.children[index]?.focus();
    };
    const move = (from, to) => {
      if (to >= 0 && to < plan.length && from !== to) {
        const [item] = plan.splice(from, 1);
        plan.splice(to, 0, item);
      }
      render();
      list.children[Math.max(0, Math.min(to, plan.length - 1))]?.focus();
    };

    // Menu d'actions façon liste déroulante, chaque action avec sa couleur, son pictogramme et sa touche.
    const openMenu = (index, anchor) => {
      if (menu?.index === index) { closeMenu(); return; }
      closeMenu();
      const node = element('div', 'rebase-menu');
      node.setAttribute('role', 'menu');
      for (const action of ACTIONS) {
        const item = element('button', `rebase-menu-item action-${action.id}${plan[index].action === action.id ? ' current' : ''}`);
        item.type = 'button';
        item.setAttribute('role', 'menuitem');
        const text = element('span', 'rebase-menu-text');
        text.append(element('strong', '', action.label), element('span', '', action.hint));
        item.append(icon(action.id), text, element('kbd', '', action.key));
        item.addEventListener('click', () => setAction(index, action.id));
        item.addEventListener('keydown', (event) => {
          const items = [...node.children];
          const at = items.indexOf(item);
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
          else if (KEYS[event.key.toLowerCase()]) { event.preventDefault(); setAction(index, KEYS[event.key.toLowerCase()]); }
          else if (event.key === 'Tab') closeMenu();
        });
        node.append(item);
      }
      dialog.append(node);
      menu = { index, node };
      const box = anchor.getBoundingClientRect();
      const frame = dialog.getBoundingClientRect();
      node.style.left = `${box.left - frame.left - dialog.clientLeft}px`;
      let top = box.bottom - frame.top - dialog.clientTop + 4;
      if (top + node.offsetHeight > dialog.clientHeight - 8) top = box.top - frame.top - dialog.clientTop - node.offsetHeight - 4;
      node.style.top = `${top}px`;
      (node.querySelector('.current') || node.firstChild).focus();
    };
    dialog.addEventListener('pointerdown', (event) => { if (menu && !menu.node.contains(event.target) && !event.target.closest('.rebase-action')) closeMenu(); });
    // Échap ferme d'abord le menu, pas le rebase entier.
    dialog.addEventListener('cancel', (event) => { if (menu) { event.preventDefault(); const index = menu.index; closeMenu(); list.children[index]?.focus(); } });

    // Glisser-déposer au pointeur : la ligne suit la souris, les autres s'écartent pour montrer où elle tombera, et
    // la liste défile toute seule près des bords.
    const startDrag = (event, index, row) => {
      if (event.button !== 0 || event.target.closest('button, textarea, input, kbd')) return;
      closeMenu();
      row.focus({ preventScroll: true });
      const rows = [...list.children];
      const state = { y: event.clientY, origin: event.clientY + list.scrollTop, target: index, active: false, frame: 0 };
      try { row.setPointerCapture(event.pointerId); } catch { /* pointeur synthétique */ }
      const update = () => {
        const dy = state.y + list.scrollTop - state.origin;
        if (!state.active) {
          if (Math.abs(dy) < 4) return;
          state.active = true;
          row.classList.add('dragging');
          list.classList.add('sorting');
        }
        row.style.transform = `translateY(${dy}px)`;
        const shift = row.offsetHeight + GAP;
        const center = row.offsetTop + row.offsetHeight / 2 + dy;
        let target = index;
        rows.forEach((other, position) => {
          if (other === row) return;
          const middle = other.offsetTop + other.offsetHeight / 2;
          let offset = 0;
          if (position < index && center < middle) { offset = shift; target -= 1; }
          if (position > index && center > middle) { offset = -shift; target += 1; }
          other.style.transform = offset ? `translateY(${offset}px)` : '';
        });
        state.target = target;
      };
      const scroll = () => {
        const box = list.getBoundingClientRect();
        const edge = 48;
        const speed = state.y < box.top + edge ? -(box.top + edge - state.y) / 3 : state.y > box.bottom - edge ? (state.y - box.bottom + edge) / 3 : 0;
        if (state.active && speed) { list.scrollTop += speed; update(); }
        state.frame = requestAnimationFrame(scroll);
      };
      state.frame = requestAnimationFrame(scroll);
      const moveHandler = (moveEvent) => { state.y = moveEvent.clientY; update(); };
      const end = () => {
        cancelAnimationFrame(state.frame);
        row.removeEventListener('pointermove', moveHandler);
        row.removeEventListener('pointerup', end);
        row.removeEventListener('pointercancel', end);
        if (!state.active) return;
        list.classList.remove('sorting');
        for (const other of rows) other.style.transform = '';
        move(index, state.target);
      };
      row.addEventListener('pointermove', moveHandler);
      row.addEventListener('pointerup', end);
      row.addEventListener('pointercancel', end);
    };

    const renderPreview = () => {
      const result = groups(plan);
      const dropped = plan.filter((item) => item.action === 'drop');
      preview.replaceChildren(element('div', 'eyebrow', 'RÉSULTAT'));
      const stats = element('p', 'rebase-stats');
      stats.append(element('strong', '', `${commits.length} → ${result.length} commit${result.length > 1 ? 's' : ''}`));
      if (dropped.length) stats.append(element('span', 'muted', ` · ${dropped.length} écarté${dropped.length > 1 ? 's' : ''}`));
      preview.append(stats);
      const history = element('ol', 'rebase-result');
      // Le plus récent en haut, comme dans le graphe.
      for (const group of [...result].reverse()) {
        const squashing = group.members.some((item) => item.action === 'squash');
        const message = squashing ? messageOf(group) : group.head.action === 'reword' ? group.head.draft : group.head.message;
        const kind = group.members.length ? 'squash' : group.head.action;
        const row = element('li', `rebase-result-row action-${kind}`);
        row.append(element('span', 'rebase-dot'), element('span', 'rebase-result-subject', message.split('\n')[0] || '(message vide)'));
        if (group.members.length) row.append(element('span', 'rebase-result-badge', `+${group.members.length}`));
        if (group.head.action === 'reword' && !group.members.length) row.append(element('span', 'rebase-result-badge reword', 'reformulé'));
        if (group.head.action === 'split') row.append(element('span', 'rebase-result-badge split', 'à découper'));
        history.append(row);
      }
      history.append(Object.assign(element('li', 'rebase-result-row base'), { textContent: `${base} (base)` }));
      preview.append(history);
      if (dropped.length) {
        const gone = element('div', 'rebase-dropped');
        gone.append(element('div', 'eyebrow', 'ÉCARTÉS'));
        for (const item of dropped) gone.append(element('div', 'rebase-dropped-row', item.subject));
        preview.append(gone);
      }
      const problem = validatePlan(plan, messageOf);
      error.textContent = problem || '';
      confirm.disabled = Boolean(problem);
    };

    const render = () => {
      closeMenu();
      list.replaceChildren(...plan.map((item, index) => {
        const group = groupOf(item);
        const merging = item.action === 'squash' || item.action === 'fixup';
        const row = element('li', `rebase-step action-${item.action}${merging ? ' merging' : ''}`);
        row.tabIndex = 0;
        row.dataset.index = String(index);
        const handle = element('span', 'rebase-handle');
        handle.innerHTML = GRIP;
        handle.title = 'Glisser pour réordonner';
        const chooser = element('button', `rebase-action action-${item.action}`);
        chooser.type = 'button';
        chooser.tabIndex = -1;
        chooser.title = `${ACTION[item.action].hint} — cliquer pour changer (P R S F D)`;
        chooser.setAttribute('aria-haspopup', 'menu');
        chooser.append(icon(item.action), element('span', 'rebase-action-label', ACTION[item.action].label), element('span', 'rebase-caret', '▾'));
        chooser.addEventListener('click', () => openMenu(index, chooser));
        const avatar = element('span', 'rebase-avatar', initials(item.author));
        avatar.style.setProperty('--hue', String(hue(item.author)));
        avatar.title = item.author;
        const info = element('div', 'rebase-info');
        const subject = element('span', 'rebase-subject', item.action === 'reword' ? item.draft.split('\n')[0] : item.subject);
        subject.title = 'Double-clic pour reformuler';
        subject.addEventListener('dblclick', () => { if (item.action !== 'reword') setAction(index, 'reword'); list.children[index]?.querySelector('textarea')?.focus(); });
        info.append(subject, element('span', 'rebase-meta', `${item.author} · ${when(item.timestamp)}`));
        row.append(handle, chooser, avatar, info, element('code', 'rebase-hash', item.shortHash));

        if (item.action === 'reword') {
          const extra = element('div', 'rebase-extra');
          const textarea = element('textarea', 'rebase-message');
          textarea.value = item.draft;
          textarea.rows = Math.min(6, Math.max(2, item.draft.split('\n').length));
          textarea.placeholder = 'Nouveau message du commit';
          textarea.addEventListener('input', () => { item.draft = textarea.value; subject.textContent = item.draft.split('\n')[0]; renderPreview(); });
          textarea.addEventListener('keydown', (event) => event.stopPropagation());
          extra.append(textarea);
          row.append(extra);
        }
        // Message du commit fusionné, sous le dernier « squash » du groupe.
        if (group && group.members.at(-1) === item && group.members.some((member) => member.action === 'squash')) {
          const extra = element('div', 'rebase-extra');
          const label = element('div', 'rebase-group-label', `Message du commit fusionné (${group.members.length + 1} commits)`);
          const textarea = element('textarea', 'rebase-message group');
          textarea.value = messageOf(group);
          textarea.rows = Math.min(8, Math.max(3, textarea.value.split('\n').length));
          textarea.addEventListener('input', () => { groupMessages.set(group.head.hash, textarea.value); renderPreview(); });
          textarea.addEventListener('keydown', (event) => event.stopPropagation());
          extra.append(label, textarea);
          row.append(extra);
        }

        row.addEventListener('pointerdown', (event) => startDrag(event, index, row));
        row.addEventListener('keydown', (event) => {
          if (event.target !== row) return;
          const key = event.key.toLowerCase();
          if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); move(index, index + (event.key === 'ArrowUp' ? -1 : 1)); return; }
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); list.children[index + (event.key === 'ArrowUp' ? -1 : 1)]?.focus(); return; }
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openMenu(index, chooser); return; }
          if (KEYS[key] && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); setAction(index, KEYS[key]); }
        });
        return row;
      }));
      renderPreview();
    };

    let result = null;
    reset.addEventListener('click', () => {
      plan.splice(0, plan.length, ...commits.map((commit) => ({ ...commit, action: 'pick', draft: commit.message })));
      groupMessages.clear();
      render();
    });
    cancel.addEventListener('click', () => dialog.close());
    confirm.addEventListener('click', () => {
      if (validatePlan(plan, messageOf)) return;
      const messages = new Map();
      for (const group of groups(plan)) {
        if (!group.members.some((item) => item.action === 'squash')) continue;
        for (const member of group.members) messages.set(member.hash, messageOf(group));
      }
      result = plan.map(({ hash, action, draft }) => {
        if (action === 'reword') return { hash, action, message: draft };
        // Git demande le message du groupe à son dernier commit, « squash » ou « fixup » : chacun le porte.
        if (messages.has(hash)) return { hash, action, message: messages.get(hash) };
        return { hash, action };
      });
      dialog.close();
    });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
    render();
    dialog.showModal();
    list.children[0]?.focus();
  });
}
