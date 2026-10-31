// Éditeur de rebase interactif : chaque commit de la branche (du plus ancien, en haut, au plus récent) reçoit une
// action, se déplace par glisser-déposer ou Alt+↑/↓, et l'aperçu montre l'historique obtenu avant de lancer quoi
// que ce soit. Raccourcis sur la ligne active : P garder, R reformuler, S fusionner, F fusionner sans message, D écarter.
const ACTIONS = [
  ['pick', 'Garder', 'P', 'Garder le commit tel quel'],
  ['reword', 'Reformuler', 'R', 'Garder le commit en changeant son message'],
  ['squash', 'Fusionner', 'S', 'Fusionner dans le commit au-dessus, messages combinés'],
  ['fixup', 'Absorber', 'F', 'Fusionner dans le commit au-dessus en gardant son message à lui'],
  ['drop', 'Écarter', 'D', 'Retirer ce commit de la branche'],
];
const KEYS = Object.fromEntries(ACTIONS.map(([action, , key]) => [key.toLowerCase(), action]));

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

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
    let focused = 0;
    let dragging = null;

    const dialog = element('dialog', 'app-dialog rebase-dialog');
    const header = element('div', 'rebase-header');
    const title = element('h2', '', 'Rebase interactif');
    const subtitle = element('p', 'dialog-hint');
    subtitle.append('Branche ', element('span', 'branch-chip', branch), ' rejouée sur ', element('code', 'sha-chip', base), ' — du plus ancien (en haut) au plus récent.');
    const legend = element('p', 'rebase-legend', 'Glisser ⋮⋮ ou Alt+↑/↓ pour réordonner · P R S F D pour changer l’action · ↑/↓ pour se déplacer');
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

    const setAction = (index, action) => {
      plan[index].action = action;
      render();
      list.children[index]?.focus();
    };
    const move = (from, to) => {
      if (to < 0 || to >= plan.length || from === to) return;
      const [item] = plan.splice(from, 1);
      plan.splice(to, 0, item);
      focused = to;
      render();
      list.children[to]?.focus();
    };

    const renderPreview = () => {
      const result = groups(plan);
      const dropped = plan.filter((item) => item.action === 'drop').length;
      preview.replaceChildren(element('div', 'eyebrow', 'RÉSULTAT'));
      const stats = element('p', 'rebase-stats');
      stats.append(element('strong', '', `${commits.length} → ${result.length} commit${result.length > 1 ? 's' : ''}`));
      if (dropped) stats.append(element('span', 'muted', ` · ${dropped} écarté${dropped > 1 ? 's' : ''}`));
      preview.append(stats);
      const history = element('ol', 'rebase-result');
      // Le plus récent en haut, comme dans le graphe.
      for (const group of [...result].reverse()) {
        const squashing = group.members.some((item) => item.action === 'squash');
        const message = squashing ? messageOf(group) : group.head.action === 'reword' ? group.head.draft : group.head.message;
        const row = element('li', `rebase-result-row${group.members.length || group.head.action === 'reword' ? ' changed' : ''}`);
        row.append(element('span', 'rebase-dot'), element('span', 'rebase-result-subject', message.split('\n')[0] || '(message vide)'));
        if (group.members.length) row.append(element('span', 'rebase-result-badge', `+${group.members.length}`));
        history.append(row);
      }
      history.append(Object.assign(element('li', 'rebase-result-row base'), { textContent: `${base} (base)` }));
      preview.append(history);
      const problem = validatePlan(plan, messageOf);
      error.textContent = problem || '';
      confirm.disabled = Boolean(problem);
    };

    const render = () => {
      list.replaceChildren(...plan.map((item, index) => {
        const group = groupOf(item);
        const merging = item.action === 'squash' || item.action === 'fixup';
        const row = element('li', `rebase-step action-${item.action}${merging ? ' merging' : ''}`);
        row.tabIndex = 0;
        row.draggable = true;
        row.dataset.index = String(index);
        const handle = element('span', 'rebase-handle', '⋮⋮'); handle.title = 'Glisser pour réordonner';
        const pills = element('div', 'rebase-pills');
        for (const [action, label, key, hint] of ACTIONS) {
          const pill = element('button', `rebase-pill pill-${action}${item.action === action ? ' active' : ''}`, label);
          pill.type = 'button';
          pill.title = `${hint} (${key})`;
          pill.tabIndex = -1;
          pill.addEventListener('click', () => setAction(index, action));
          pills.append(pill);
        }
        const info = element('div', 'rebase-info');
        const line = element('div', 'rebase-line');
        line.append(element('code', 'rebase-hash', item.shortHash), element('span', 'rebase-subject', item.action === 'reword' ? item.draft.split('\n')[0] : item.subject));
        const meta = element('div', 'rebase-meta', `${item.author} · ${when(item.timestamp)}`);
        info.append(line, meta);
        row.append(handle, pills, info);

        if (item.action === 'reword') {
          const textarea = element('textarea', 'rebase-message');
          textarea.value = item.draft;
          textarea.rows = Math.min(6, Math.max(2, item.draft.split('\n').length));
          textarea.placeholder = 'Nouveau message du commit';
          textarea.addEventListener('input', () => { item.draft = textarea.value; line.querySelector('.rebase-subject').textContent = item.draft.split('\n')[0]; renderPreview(); });
          textarea.addEventListener('keydown', (event) => event.stopPropagation());
          info.append(textarea);
        }
        // Message du commit fusionné, sous le dernier « squash » du groupe.
        if (group && group.members.at(-1) === item && group.members.some((member) => member.action === 'squash')) {
          const label = element('div', 'rebase-group-label', `Message du commit fusionné (${group.members.length + 1} commits)`);
          const textarea = element('textarea', 'rebase-message group');
          textarea.value = messageOf(group);
          textarea.rows = Math.min(8, Math.max(3, textarea.value.split('\n').length));
          textarea.addEventListener('input', () => { groupMessages.set(group.head.hash, textarea.value); renderPreview(); });
          textarea.addEventListener('keydown', (event) => event.stopPropagation());
          info.append(label, textarea);
        }

        row.addEventListener('focus', () => { focused = index; });
        row.addEventListener('keydown', (event) => {
          if (event.target !== row) return;
          const key = event.key.toLowerCase();
          if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); move(index, index + (event.key === 'ArrowUp' ? -1 : 1)); return; }
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); list.children[index + (event.key === 'ArrowUp' ? -1 : 1)]?.focus(); return; }
          if (KEYS[key] && !event.ctrlKey && !event.metaKey) { event.preventDefault(); setAction(index, KEYS[key]); }
        });
        row.addEventListener('dragstart', (event) => { dragging = index; row.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(index)); });
        row.addEventListener('dragend', () => { dragging = null; row.classList.remove('dragging'); list.querySelectorAll('.drop-before,.drop-after').forEach((node) => node.classList.remove('drop-before', 'drop-after')); });
        row.addEventListener('dragover', (event) => {
          if (dragging === null) return;
          event.preventDefault();
          const after = event.offsetY > row.offsetHeight / 2;
          row.classList.toggle('drop-after', after);
          row.classList.toggle('drop-before', !after);
        });
        row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
        row.addEventListener('drop', (event) => {
          event.preventDefault();
          if (dragging === null) return;
          const after = row.classList.contains('drop-after');
          let target = index + (after ? 1 : 0);
          if (dragging < target) target -= 1;
          move(dragging, target);
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
