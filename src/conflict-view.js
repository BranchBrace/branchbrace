import { baseOptions, languageFor, monaco } from './monaco.js';
import { parseConflicts, resolveAll, resolveBlock } from './conflicts.js';

// Outil de fusion : en haut, ce que chaque côté a changé par rapport à leur base commune ; en bas, le résultat
// (le fichier avec ses marqueurs), modifiable. Au-dessus de chaque conflit restant, des actions façon VS Code :
// garder l'actuel, l'entrant, les deux ou la base. Ctrl+Z annule une résolution.
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Pendant un rebase, « ours » est la branche sur laquelle on rejoue et « theirs » le commit rejoué.
function sideLabels(operation) {
  if (operation === 'rebase') return { ours: 'Base du rebase (HEAD)', theirs: 'Commit rejoué' };
  if (operation === 'cherry-pick') return { ours: 'Actuel (HEAD)', theirs: 'Commit cueilli' };
  if (operation === 'revert') return { ours: 'Actuel (HEAD)', theirs: 'Annulation' };
  return { ours: 'Actuel (HEAD)', theirs: 'Entrant' };
}

let editors = [];
let models = [];
function dispose() {
  for (const editor of editors) { editor.setModel(null); editor.dispose(); }
  for (const model of models) model.dispose();
  editors = [];
  models = [];
}

export function showConflict(container, toolbar, { data, onResolve, onClose }) {
  dispose();
  const labels = sideLabels(data.operation);
  if (data.binary || data.merged === null) {
    // Fichier binaire, ou supprimé d'un côté : pas de fusion ligne à ligne, on choisit une version entière.
    const box = element('div', 'conflict-choice');
    box.append(element('h2', '', data.binary ? 'Conflit sur un fichier binaire' : 'Fichier supprimé d’un côté'));
    box.append(element('p', 'muted', data.binary
      ? 'Ce fichier ne peut pas être fusionné ligne à ligne. Gardez une version entière avec Git (git checkout --ours / --theirs puis git add), ou supprimez-le.'
      : `${data.ours === null ? `Supprimé côté « ${labels.ours} »` : `Supprimé côté « ${labels.theirs} »`}. Choisissez la version à garder.`));
    const actions = element('div', 'conflict-choice-actions');
    const add = (text, content, kind = 'secondary') => {
      const button = element('button', `button ${kind}`, text);
      button.addEventListener('click', () => onResolve(content));
      actions.append(button);
    };
    if (!data.binary && data.ours !== null) add(`Garder « ${labels.ours} »`, data.ours, 'primary');
    if (!data.binary && data.theirs !== null) add(`Garder « ${labels.theirs} »`, data.theirs, 'primary');
    add('Supprimer le fichier', null);
    box.append(actions);
    container.replaceChildren(box);
    toolbar.replaceChildren();
    return;
  }

  const language = languageFor(data.path);
  const top = element('div', 'merge-sides');
  const pane = (title, hint, className) => {
    const wrapper = element('div', `merge-pane ${className}`);
    const head = element('div', 'merge-pane-head');
    head.append(element('span', 'merge-pane-title', title), element('span', 'merge-pane-hint', hint));
    const body = element('div', 'merge-pane-body');
    wrapper.append(head, body);
    return { wrapper, head, body };
  };
  const ours = pane(labels.ours, 'changements de ce côté depuis la base commune', 'ours');
  const theirs = pane(labels.theirs, 'changements de ce côté depuis la base commune', 'theirs');
  top.append(ours.wrapper, theirs.wrapper);
  const output = pane('Résultat', 'modifiable — c’est ce fichier qui sera enregistré', 'output');
  const counter = element('span', 'merge-counter');
  output.head.append(counter);
  container.replaceChildren(top, output.wrapper);

  const sideEditor = (host, text) => {
    const editor = monaco.editor.createDiffEditor(host, {
      ...baseOptions, readOnly: true, renderSideBySide: false, minimap: { enabled: false }, renderOverviewRuler: false,
      hideUnchangedRegions: { enabled: false }, lineNumbersMinChars: 3, stickyScroll: { enabled: false },
    });
    const original = monaco.editor.createModel(data.base ?? '', language);
    const modified = monaco.editor.createModel(text ?? '', language);
    models.push(original, modified);
    editor.setModel({ original, modified });
    editors.push(editor);
    return editor;
  };
  sideEditor(ours.body, data.ours);
  sideEditor(theirs.body, data.theirs);

  const model = monaco.editor.createModel(data.merged, language);
  models.push(model);
  const result = monaco.editor.create(output.body, { ...baseOptions, model, minimap: { enabled: false }, glyphMargin: false });
  editors.push(result);

  let decorations = result.createDecorationsCollection();
  let zones = [];
  let widgets = [];
  let index = 0;
  const conflicts = () => parseConflicts(model.getValue()).filter((block) => block.type === 'conflict');

  // Remplace le bloc par sa résolution en une seule opération annulable.
  const apply = (block, choice) => {
    const end = block.endLine;
    const range = new monaco.Range(block.startLine, 1, end + 1 <= model.getLineCount() ? end + 1 : end, end + 1 <= model.getLineCount() ? 1 : model.getLineMaxColumn(end));
    result.pushUndoStop();
    result.executeEdits('merge', [{ range, text: resolveBlock(block, choice) }]);
    result.pushUndoStop();
  };

  const refresh = () => {
    const blocks = conflicts();
    index = Math.min(index, Math.max(blocks.length - 1, 0));
    counter.textContent = blocks.length ? `${blocks.length} conflit${blocks.length > 1 ? 's' : ''} restant${blocks.length > 1 ? 's' : ''}` : 'Tous les conflits sont résolus';
    counter.classList.toggle('done', !blocks.length);
    // Couleurs : côté courant vert, côté entrant bleu, base grisée, marqueurs atténués.
    const ranges = [];
    for (const block of blocks) {
      const oursStart = block.startLine + 1;
      const oursEnd = oursStart + block.ours.length - 1;
      const baseStart = oursEnd + 2;
      const theirsStart = block.base ? baseStart + block.base.length + 1 : oursEnd + 2;
      const theirsEnd = theirsStart + block.theirs.length - 1;
      const whole = (start, end, className) => { if (end >= start) ranges.push({ range: new monaco.Range(start, 1, end, 1), options: { isWholeLine: true, className } }); };
      whole(block.startLine, block.startLine, 'merge-marker');
      whole(oursStart, oursEnd, 'merge-ours');
      if (block.base) { whole(oursEnd + 1, oursEnd + 1, 'merge-marker'); whole(baseStart, baseStart + block.base.length - 1, 'merge-base'); }
      whole(theirsStart - 1, theirsStart - 1, 'merge-marker');
      whole(theirsStart, theirsEnd, 'merge-theirs');
      whole(block.endLine, block.endLine, 'merge-marker');
    }
    decorations.set(ranges);
    // Barre d'actions au-dessus de chaque conflit : une zone vide réserve la ligne, un widget y place les boutons.
    for (const widget of widgets) result.removeContentWidget(widget);
    widgets = [];
    result.changeViewZones((accessor) => {
      for (const zone of zones) accessor.removeZone(zone);
      zones = blocks.map((block) => accessor.addZone({ afterLineNumber: block.startLine - 1, heightInLines: 1.3, domNode: element('div') }));
    });
    blocks.forEach((block, position) => {
      const node = element('div', 'merge-lens');
      const action = (text, choice, title) => {
        const button = element('button', 'merge-lens-action', text);
        button.title = title;
        // mousedown neutralisé pour que Monaco ne déplace pas le curseur ; l'action part au clic.
        button.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation(); });
        button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); apply(block, choice); });
        node.append(button);
      };
      action('Garder l’actuel', 'ours', `Remplacer ce conflit par la version « ${labels.ours} »`);
      action('Garder l’entrant', 'theirs', `Remplacer ce conflit par la version « ${labels.theirs} »`);
      action('Les deux', 'both', 'Garder les deux versions, la courante d’abord');
      if (block.base) action('Base', 'base', 'Revenir à la version de la base commune');
      node.append(element('span', 'merge-lens-index', `${position + 1}/${blocks.length}`));
      const widget = {
        getId: () => `merge-lens-${position}`,
        getDomNode: () => node,
        getPosition: () => ({ position: { lineNumber: block.startLine, column: 1 }, preference: [monaco.editor.ContentWidgetPositionPreference.ABOVE] }),
      };
      result.addContentWidget(widget);
      widgets.push(widget);
    });
    renderToolbar(blocks.length);
  };

  const go = (offset) => {
    const blocks = conflicts();
    if (!blocks.length) return;
    index = (index + offset + blocks.length) % blocks.length;
    result.revealLineInCenter(blocks[index].startLine);
    result.setPosition({ lineNumber: blocks[index].startLine + 1, column: 1 });
    result.focus();
  };

  const renderToolbar = (remaining) => {
    const nav = element('span', 'segmented');
    const previous = element('button', 'chip-toggle', '↑'); previous.title = 'Conflit précédent';
    const next = element('button', 'chip-toggle', '↓'); next.title = 'Conflit suivant';
    previous.addEventListener('click', () => go(-1));
    next.addEventListener('click', () => go(1));
    previous.disabled = next.disabled = !remaining;
    nav.append(previous, next);
    const all = (text, choice) => {
      const button = element('button', 'chip-toggle', text);
      button.disabled = !remaining;
      button.addEventListener('click', () => { result.pushUndoStop(); result.executeEdits('merge', [{ range: model.getFullModelRange(), text: resolveAll(model.getValue(), choice) }]); result.pushUndoStop(); });
      return button;
    };
    const save = element('button', 'button primary compact', 'Enregistrer et marquer résolu');
    save.disabled = remaining > 0;
    save.title = remaining ? 'Résolvez d’abord tous les conflits (ou éditez le résultat à la main)' : 'Écrit le résultat dans le fichier puis l’ajoute à l’index (git add)';
    save.addEventListener('click', () => onResolve(model.getValue()));
    const close = element('button', 'button secondary compact', 'Fermer');
    close.addEventListener('click', onClose);
    toolbar.replaceChildren(nav, all('Tout l’actuel', 'ours'), all('Tout l’entrant', 'theirs'), save, close);
  };

  let pending = null;
  model.onDidChangeContent(() => { clearTimeout(pending); pending = setTimeout(refresh, 120); });
  result.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { if (!conflicts().length) onResolve(model.getValue()); });
  refresh();
  setTimeout(() => go(0), 50);
}

export const disposeConflict = dispose;
