import { baseOptions, languageFor, monaco } from './monaco.js';
import { parseConflicts, resolveBlock, textSpan } from './conflicts.js';

// Outil de fusion : en haut, ce que chaque côté a changé par rapport à leur base commune ; en bas, le résultat
// (le fichier avec ses marqueurs), modifiable. Au-dessus de chaque conflit restant, des actions façon VS Code :
// garder l'actuel, l'entrant, les deux ou la base ; au-dessus de chaque conflit résolu, le choix fait (retouché ou
// non) et de quoi le rétablir. Le mode Revue relit le résultat face à l'une des versions avant d'enregistrer.
// Ctrl+Z annule une résolution.
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
  const reviewPane = pane('Revue du résultat', 'à gauche la référence, à droite le résultat — toujours modifiable', 'review');
  reviewPane.wrapper.hidden = true;
  container.replaceChildren(top, output.wrapper, reviewPane.wrapper);

  const references = {
    ours: monaco.editor.createModel(data.ours ?? '', language),
    theirs: monaco.editor.createModel(data.theirs ?? '', language),
    base: monaco.editor.createModel(data.base ?? '', language),
  };
  models.push(...Object.values(references));
  const sideEditor = (host, modified) => {
    const editor = monaco.editor.createDiffEditor(host, {
      ...baseOptions, readOnly: true, renderSideBySide: false, minimap: { enabled: false }, renderOverviewRuler: false,
      hideUnchangedRegions: { enabled: false }, lineNumbersMinChars: 3, stickyScroll: { enabled: false },
    });
    editor.setModel({ original: references.base, modified });
    editors.push(editor);
    return editor;
  };
  sideEditor(ours.body, references.ours);
  sideEditor(theirs.body, references.theirs);

  const model = monaco.editor.createModel(data.merged, language);
  models.push(model);
  const result = monaco.editor.create(output.body, { ...baseOptions, model, minimap: { enabled: false }, glyphMargin: false });
  editors.push(result);

  let decorations = result.createDecorationsCollection();
  let zones = [];
  let widgets = [];
  let index = 0;
  const conflicts = () => parseConflicts(model.getValue()).filter((block) => block.type === 'conflict');
  const save = () => { if (!conflicts().length) onResolve(model.getValue()); };

  // Résolutions faites ici, pour la revue : plage suivie par Monaco (elle se décale avec les éditions), choix, texte
  // inséré (pour repérer une retouche à la main), bloc d'origine avec ses marqueurs (pour le rétablir) et version
  // du modèle juste après (pour savoir qu'un Ctrl+Z l'a défaite).
  const choiceLabels = { ours: labels.ours, theirs: labels.theirs, both: 'Les deux', base: 'Base' };
  let resolutions = [];
  const forget = (...entries) => {
    model.deltaDecorations(entries.map((entry) => entry.id), []);
    resolutions = resolutions.filter((entry) => !entries.includes(entry));
  };
  const blockRange = (block) => (block.endLine < model.getLineCount()
    ? new monaco.Range(block.startLine, 1, block.endLine + 1, 1)
    : new monaco.Range(block.startLine, 1, block.endLine, model.getLineMaxColumn(block.endLine)));

  // Résout des blocs en une seule opération annulable, du bas vers le haut pour que les numéros de ligne des blocs
  // suivants restent valables.
  const apply = (blocks, choice) => {
    result.pushUndoStop();
    for (const block of [...blocks].sort((a, b) => b.startLine - a.startLine)) {
      const range = blockRange(block);
      const original = model.getValueInRange(range);
      const text = resolveBlock(block, choice);
      result.executeEdits('merge', [{ range, text }]);
      const span = textSpan(block.startLine, text);
      const [id] = model.deltaDecorations([], [{
        range: new monaco.Range(span.startLine, 1, span.endLine, span.endColumn),
        options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
      }]);
      resolutions.push({ id, choice, text: text.replace(/\r\n/g, '\n'), original, version: model.getAlternativeVersionId() });
    }
    result.pushUndoStop();
  };

  // Remet le bloc d'origine, marqueurs compris, à la place de la résolution (retouches incluses) : annulable aussi.
  const restore = (entry) => {
    const range = model.getDecorationRange(entry.id);
    forget(entry);
    if (!range) return;
    result.pushUndoStop();
    result.executeEdits('merge', [{ range, text: entry.original }]);
    result.pushUndoStop();
  };

  // État de chaque résolution suivie : sa plage actuelle et si elle a été retouchée depuis.
  const resolved = () => resolutions.map((entry) => {
    const range = model.getDecorationRange(entry.id);
    return range && { entry, range, edited: model.getValueInRange(range, monaco.editor.EndOfLinePreference.LF) !== entry.text };
  }).filter(Boolean).sort((a, b) => a.range.startLineNumber - b.range.startLineNumber);

  const lensButton = (text, title, onClick) => {
    const button = element('button', 'merge-lens-action', text);
    button.title = title;
    // mousedown neutralisé pour que Monaco ne déplace pas le curseur ; l'action part au clic.
    button.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation(); });
    button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); onClick(); });
    return button;
  };

  const refresh = () => {
    const blocks = conflicts();
    const done = resolved();
    index = Math.min(index, Math.max(blocks.length - 1, 0));
    counter.textContent = blocks.length
      ? `${blocks.length} conflit${blocks.length > 1 ? 's' : ''} restant${blocks.length > 1 ? 's' : ''}`
      : 'Tous les conflits sont résolus — passez en revue avant d’enregistrer';
    counter.classList.toggle('done', !blocks.length);
    // Couleurs : côté courant vert, côté entrant bleu, base grisée, marqueurs atténués ; résolu, un liseré dans la marge.
    const ranges = [];
    const whole = (start, end, options) => { if (end >= start) ranges.push({ range: new monaco.Range(start, 1, end, 1), options: { isWholeLine: true, ...options } }); };
    for (const block of blocks) {
      const oursStart = block.startLine + 1;
      const oursEnd = oursStart + block.ours.length - 1;
      const baseStart = oursEnd + 2;
      const theirsStart = block.base ? baseStart + block.base.length + 1 : oursEnd + 2;
      const theirsEnd = theirsStart + block.theirs.length - 1;
      whole(block.startLine, block.startLine, { className: 'merge-marker' });
      whole(oursStart, oursEnd, { className: 'merge-ours' });
      if (block.base) { whole(oursEnd + 1, oursEnd + 1, { className: 'merge-marker' }); whole(baseStart, baseStart + block.base.length - 1, { className: 'merge-base' }); }
      whole(theirsStart - 1, theirsStart - 1, { className: 'merge-marker' });
      whole(theirsStart, theirsEnd, { className: 'merge-theirs' });
      whole(block.endLine, block.endLine, { className: 'merge-marker' });
    }
    for (const { range, edited } of done) {
      const end = range.endColumn === 1 ? range.endLineNumber - 1 : range.endLineNumber;
      whole(range.startLineNumber, end, { className: 'merge-resolved', linesDecorationsClassName: edited ? 'merge-resolved-gutter edited' : 'merge-resolved-gutter' });
    }
    decorations.set(ranges);

    // Une barre d'actions au-dessus de chaque conflit restant ou résolu ; une seule par ligne, quitte à les réunir
    // (une résolution vide suivie d'un autre conflit tombe sur la même ligne). Une zone vide réserve la hauteur, un
    // widget y place les boutons.
    const lenses = new Map();
    const lensAt = (line) => {
      if (!lenses.has(line)) lenses.set(line, element('div', 'merge-lens'));
      return lenses.get(line);
    };
    done.forEach(({ entry, range, edited }) => {
      const node = lensAt(range.startLineNumber);
      node.append(element('span', `merge-lens-status${edited ? ' edited' : ''}`, `✓ ${choiceLabels[entry.choice]}${edited ? ' · retouché' : ''}`));
      node.append(lensButton('Rétablir le conflit', 'Remettre ce conflit tel qu’il était, marqueurs compris (retouches perdues ; Ctrl+Z pour revenir)', () => restore(entry)));
    });
    blocks.forEach((block, position) => {
      const node = lensAt(block.startLine);
      const action = (text, choice, title) => node.append(lensButton(text, title, () => apply([block], choice)));
      action('Garder l’actuel', 'ours', `Remplacer ce conflit par la version « ${labels.ours} »`);
      action('Garder l’entrant', 'theirs', `Remplacer ce conflit par la version « ${labels.theirs} »`);
      action('Les deux', 'both', 'Garder les deux versions, la courante d’abord');
      if (block.base) action('Base', 'base', 'Revenir à la version de la base commune');
      node.append(element('span', 'merge-lens-index', `${position + 1}/${blocks.length}`));
    });
    for (const widget of widgets) result.removeContentWidget(widget);
    result.changeViewZones((accessor) => {
      for (const zone of zones) accessor.removeZone(zone);
      zones = [...lenses.keys()].map((line) => accessor.addZone({ afterLineNumber: line - 1, heightInLines: 1.3, domNode: element('div') }));
    });
    widgets = [...lenses].map(([line, node]) => ({
      getId: () => `merge-lens-${line}`,
      getDomNode: () => node,
      getPosition: () => ({ position: { lineNumber: line, column: 1 }, preference: [monaco.editor.ContentWidgetPositionPreference.ABOVE] }),
    }));
    for (const widget of widgets) result.addContentWidget(widget);
    renderSummary(blocks, done);
    renderToolbar(blocks.length);
  };

  // Revue : le résultat face à une version de référence, en côte à côte. Le côté droit est le même modèle que le
  // résultat : une correction faite ici en est une là-bas.
  let review = null;
  let reference = 'ours';
  const summary = element('div', 'merge-summary');
  const referenceSwitch = element('span', 'segmented');
  const differences = element('span', 'merge-counter');
  reviewPane.head.append(element('span', 'merge-switch-label', 'Comparer à'), referenceSwitch, differences);
  reviewPane.wrapper.insertBefore(summary, reviewPane.body);
  const renderReferences = () => {
    const option = (key, text) => {
      const button = element('button', `chip-toggle${reference === key ? ' active' : ''}`, text);
      button.title = `Comparer le résultat à la version « ${text} »`;
      button.disabled = key === 'base' && data.base === null;
      button.addEventListener('click', () => { reference = key; review?.setModel({ original: references[key], modified: model }); renderReferences(); });
      return button;
    };
    referenceSwitch.replaceChildren(option('ours', labels.ours), option('theirs', labels.theirs), option('base', 'Base commune'));
  };
  const countDifferences = () => {
    const changes = review?.getLineChanges();
    if (!changes) return;
    differences.textContent = changes.length ? `${changes.length} écart${changes.length > 1 ? 's' : ''} avec la référence` : 'Identique à la référence';
  };
  const reveal = (line) => {
    const editor = review ? review.getModifiedEditor() : result;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  };
  // Pastilles de la revue : chaque conflit, dans l'ordre du fichier, avec ce qui en a été fait ; un clic y mène.
  function renderSummary(blocks, done) {
    const items = [
      ...done.map(({ entry, range, edited }) => ({ line: range.startLineNumber, text: `${choiceLabels[entry.choice]}${edited ? ' · retouché' : ''}`, state: edited ? 'edited' : 'resolved' })),
      ...blocks.map((block) => ({ line: block.startLine, text: 'à résoudre', state: 'remaining' })),
    ].sort((a, b) => a.line - b.line);
    summary.replaceChildren(element('span', 'merge-switch-label', items.length ? 'Conflits' : 'Aucune résolution faite ici : le résultat a été édité à la main'));
    items.forEach((item, position) => {
      const chip = element('button', `merge-chip ${item.state}`, `${position + 1}. ${item.text}`);
      chip.title = `Ligne ${item.line}`;
      chip.addEventListener('click', () => reveal(item.line));
      summary.append(chip);
    });
  }
  const setReview = (open) => {
    if (open === Boolean(review)) return;
    top.hidden = output.wrapper.hidden = open;
    reviewPane.wrapper.hidden = !open;
    container.classList.toggle('reviewing', open);
    if (open) {
      review = monaco.editor.createDiffEditor(reviewPane.body, {
        ...baseOptions, renderSideBySide: true, originalEditable: false, minimap: { enabled: false }, glyphMargin: false,
        hideUnchangedRegions: { enabled: false }, renderMarginRevertIcon: false,
      });
      review.setModel({ original: references[reference], modified: model });
      review.onDidUpdateDiff(countDifferences);
      review.getModifiedEditor().addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
      editors.push(review);
    } else {
      review.setModel(null);
      review.dispose();
      editors = editors.filter((editor) => editor !== review);
      review = null;
    }
    renderReferences();
    refresh();
  };

  const go = (offset) => {
    if (review) { review.goToDiff(offset < 0 ? 'previous' : 'next'); return; }
    const blocks = conflicts();
    if (!blocks.length) return;
    index = (index + offset + blocks.length) % blocks.length;
    reveal(blocks[index].startLine);
  };

  function renderToolbar(remaining) {
    const mode = element('span', 'segmented');
    const tab = (text, open, title) => {
      const button = element('button', `chip-toggle${Boolean(review) === open ? ' active' : ''}`, text);
      button.title = title;
      button.addEventListener('click', () => setReview(open));
      mode.append(button);
    };
    tab('Fusion', false, 'Les deux côtés face à la base, et le résultat avec ses conflits');
    tab('Revue', true, 'Relire le résultat face à l’actuel, l’entrant ou la base, et le corriger avant d’enregistrer');
    const nav = element('span', 'segmented');
    const previous = element('button', 'chip-toggle', '↑'); previous.title = review ? 'Écart précédent' : 'Conflit précédent';
    const next = element('button', 'chip-toggle', '↓'); next.title = review ? 'Écart suivant' : 'Conflit suivant';
    previous.addEventListener('click', () => go(-1));
    next.addEventListener('click', () => go(1));
    previous.disabled = next.disabled = !review && !remaining;
    nav.append(previous, next);
    const all = (text, choice) => {
      const button = element('button', 'chip-toggle', text);
      button.disabled = !remaining;
      button.addEventListener('click', () => apply(conflicts(), choice));
      return button;
    };
    const saveButton = element('button', 'button primary compact', 'Enregistrer et marquer résolu');
    saveButton.disabled = remaining > 0;
    saveButton.title = remaining ? 'Résolvez d’abord tous les conflits (ou éditez le résultat à la main)' : 'Écrit le résultat dans le fichier puis l’ajoute à l’index (git add)';
    saveButton.addEventListener('click', save);
    const close = element('button', 'button secondary compact', 'Fermer');
    close.addEventListener('click', onClose);
    toolbar.replaceChildren(mode, nav, ...(review ? [] : [all('Tout l’actuel', 'ours'), all('Tout l’entrant', 'theirs')]), saveButton, close);
  }

  let pending = null;
  model.onDidChangeContent((event) => {
    // Un Ctrl+Z qui remonte avant une résolution la défait : elle n'est plus suivie (le conflit revient tel quel).
    if (event.isUndoing) forget(...resolutions.filter((entry) => entry.version > model.getAlternativeVersionId()));
    clearTimeout(pending);
    pending = setTimeout(refresh, 120);
  });
  result.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
  refresh();
  setTimeout(() => go(0), 50);
}

export const disposeConflict = dispose;
