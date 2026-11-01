import { baseOptions, languageFor, monaco } from './monaco.js';

// Vue centrale de diff : éditeur de diff Monaco (côte à côte ou en ligne, zones inchangées repliables, surlignage
// au mot près). Pour un fichier non indexé, le côté droit est le fichier de travail lui-même : modifiable, Ctrl+S
// l'enregistre.
const PREFS_KEY = 'branchbrace.diff';
function readPrefs() {
  try { return { sideBySide: true, collapse: true, wrap: false, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
  catch { return { sideBySide: true, collapse: true, wrap: false }; }
}
const prefs = readPrefs();
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* stockage indisponible */ } };
// Partagées avec la revue de commit : côte à côte / en ligne et retour à la ligne valent pour tous les diffs.
export { prefs as diffPrefs, savePrefs as saveDiffPrefs };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let editor = null;
let models = [];
let current = null;
let shownPath = null;
// Côté (original/modified) qui a eu le focus en dernier : sa sélection, même vide, désigne les lignes visées.
let focusedSide = 'modified';
let partialDisposables = [];
let glyphs = null;

// Blocs de changement de Monaco au format attendu par l'indexation partielle : début 1-based et nombre de lignes de
// chaque côté (pour un côté vide, le début est la ligne qui suit l'emplacement). `raw` garde la forme Monaco.
function blocks() {
  return (editor?.getLineChanges() || []).map((change) => ({
    originalStart: change.originalEndLineNumber === 0 ? change.originalStartLineNumber + 1 : change.originalStartLineNumber,
    originalCount: change.originalEndLineNumber === 0 ? 0 : change.originalEndLineNumber - change.originalStartLineNumber + 1,
    modifiedStart: change.modifiedEndLineNumber === 0 ? change.modifiedStartLineNumber + 1 : change.modifiedStartLineNumber,
    modifiedCount: change.modifiedEndLineNumber === 0 ? 0 : change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1,
    raw: change,
  }));
}

const range = (start, count) => Array.from({ length: count }, (_, k) => start + k);
const hunkSelection = (block) => ({ original: range(block.originalStart, block.originalCount), modified: range(block.modifiedStart, block.modifiedCount) });

// Bloc sous le curseur du dernier côté actif (un bloc vide de ce côté se repère à la ligne qui le précède).
function blockAtCursor(list) {
  const side = focusedSide === 'original' && prefs.sideBySide ? 'original' : 'modified';
  const line = (side === 'original' ? editor.getOriginalEditor() : editor.getModifiedEditor()).getPosition()?.lineNumber;
  return list.find((block) => {
    const start = block.raw[`${side}StartLineNumber`];
    return line >= start && line <= Math.max(start, block.raw[`${side}EndLineNumber`]);
  }) || null;
}

// Lignes sélectionnées dans chaque éditeur. Dans un bloc, une ligne choisie d'un côté entraîne la ligne de même rang
// de l'autre côté (une ligne modifiée = sa suppression et son ajout) ; la dernière entraîne aussi celles qui restent.
// En ligne, seules les lignes du fichier modifié sont sélectionnables : ce couplage rend leurs remplacements indexables.
function selectedLines(list) {
  const lines = (side) => {
    const sideEditor = side === 'original' ? editor.getOriginalEditor() : editor.getModifiedEditor();
    const selections = sideEditor.getSelections() || [];
    const active = side === focusedSide || selections.some((selection) => !selection.isEmpty());
    if (!active || (side === 'original' && !prefs.sideBySide)) return new Set();
    const set = new Set();
    for (const selection of selections) {
      const end = selection.endLineNumber > selection.startLineNumber && selection.endColumn === 1 ? selection.endLineNumber - 1 : selection.endLineNumber;
      for (let line = selection.startLineNumber; line <= end; line += 1) set.add(line);
    }
    return set;
  };
  const chosen = { original: lines('original'), modified: lines('modified') };
  const result = { original: new Set(chosen.original), modified: new Set(chosen.modified) };
  const pair = (from, to, block) => {
    const fromStart = block[`${from}Start`]; const fromCount = block[`${from}Count`];
    const toStart = block[`${to}Start`]; const toCount = block[`${to}Count`];
    for (let offset = 0; offset < fromCount; offset += 1) {
      if (!chosen[from].has(fromStart + offset)) continue;
      const last = offset === fromCount - 1 ? toCount : offset + 1;
      for (let paired = offset; paired < Math.min(last, toCount); paired += 1) result[to].add(toStart + paired);
    }
  };
  for (const block of list) { pair('original', 'modified', block); pair('modified', 'original', block); }
  return { original: [...result.original], modified: [...result.modified] };
}

function options() {
  return {
    renderSideBySide: prefs.sideBySide,
    useInlineViewWhenSpaceIsLimited: false,
    hideUnchangedRegions: { enabled: prefs.collapse, contextLineCount: 3, minimumLineCount: 4, revealLineCount: 20 },
    wordWrap: prefs.wrap ? 'on' : 'off',
    diffWordWrap: prefs.wrap ? 'on' : 'off',
  };
}

function ensureEditor(container) {
  if (editor) return editor;
  editor = monaco.editor.createDiffEditor(container, {
    ...baseOptions,
    ...options(),
    originalEditable: false,
    renderOverviewRuler: true,
    diffAlgorithm: 'advanced',
    ignoreTrimWhitespace: false,
    renderMarginRevertIcon: false,
    enableSplitViewResizing: true,
    minimap: { enabled: false },
  });
  editor.getModifiedEditor().addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => current?.save());
  editor.getOriginalEditor().onDidFocusEditorText(() => { focusedSide = 'original'; });
  editor.getModifiedEditor().onDidFocusEditorText(() => { focusedSide = 'modified'; });
  glyphs = editor.getModifiedEditor().createDecorationsCollection();
  // Clic sur l'icône de marge d'un bloc : l'indexer (ou le désindexer) en entier.
  editor.getModifiedEditor().onMouseDown((event) => {
    if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !current?.partial) return;
    const line = event.target.position?.lineNumber;
    const block = blocks().find((item) => glyphLine(item) === line);
    if (block) current.partial.hunk(block);
  });
  editor.onDidUpdateDiff(() => current?.partial?.decorate());
  return editor;
}

const glyphLine = (block) => Math.max(1, block.raw.modifiedStartLineNumber);

const toggle = (label, title, active, onClick) => {
  const button = element('button', `chip-toggle${active ? ' active' : ''}`, label);
  button.title = title;
  button.setAttribute('aria-pressed', String(active));
  button.addEventListener('click', onClick);
  return button;
};

// `data` : { original, modified, existsBefore, existsAfter, editable } ou { binary } / { tooLarge }.
// `actions` : boutons propres au contexte (indexer, ouvrir dans l'éditeur…) ; `onSave(texte)` si modifiable.
// `lines` : { verb: 'Indexer' | 'Désindexer', apply(request) } pour indexer ou désindexer un bloc ou des lignes.
export function showDiff(container, toolbar, { path, data, actions = [], onSave, lines = null }) {
  const render = () => {
    const tools = [
      element('span', 'segmented'),
    ];
    tools[0].append(
      toggle('Côte à côte', 'Ancienne version à gauche, nouvelle à droite', prefs.sideBySide, () => { prefs.sideBySide = true; apply(); }),
      toggle('En ligne', 'Suppressions et ajouts dans un seul fichier', !prefs.sideBySide, () => { prefs.sideBySide = false; apply(); }),
    );
    tools.push(
      toggle('Replier l’inchangé', 'Ne montrer que les zones modifiées et leur contexte', prefs.collapse, () => { prefs.collapse = !prefs.collapse; apply(); }),
      toggle('↵', 'Retour à la ligne automatique', prefs.wrap, () => { prefs.wrap = !prefs.wrap; apply(); }),
    );
    if (editor && !data.binary && !data.tooLarge) {
      const nav = element('span', 'segmented');
      const previous = element('button', 'chip-toggle', '↑'); previous.title = 'Changement précédent (Maj+F7)';
      const next = element('button', 'chip-toggle', '↓'); next.title = 'Changement suivant (F7)';
      previous.addEventListener('click', () => editor.goToDiff('previous'));
      next.addEventListener('click', () => editor.goToDiff('next'));
      nav.append(previous, next);
      tools.push(nav);
    }
    if (current?.partial) {
      const partial = element('span', 'segmented');
      const verb = lines.verb;
      const hunk = element('button', 'chip-toggle', `${verb} le bloc`);
      const selection = element('button', 'chip-toggle', `${verb} les lignes`);
      hunk.title = `${verb} le bloc de changements sous le curseur (ou cliquez l’icône dans la marge du bloc)`;
      selection.title = `${verb} les lignes sélectionnées ; dans un bloc, la ligne d’en face (suppression ou ajout) suit`;
      for (const button of [hunk, selection]) {
        button.disabled = current.dirty;
        if (current.dirty) button.title = 'Enregistrez d’abord le fichier (Ctrl+S) : seules les lignes enregistrées peuvent être indexées.';
      }
      hunk.addEventListener('click', () => current?.partial.cursorHunk());
      selection.addEventListener('click', () => current?.partial.selectedLines());
      partial.append(hunk, selection);
      tools.push(partial);
    }
    if (current?.dirty) tools.push(element('span', 'dirty-flag', '● non enregistré — Ctrl+S'));
    toolbar.replaceChildren(...tools, ...actions);
  };
  const apply = () => { savePrefs(); editor?.updateOptions(options()); render(); };

  // Les anciens modèles ne sont libérés qu'une fois détachés de l'éditeur.
  const previous = models;
  models = [];
  current = null;
  for (const disposable of partialDisposables) disposable.dispose();
  partialDisposables = [];
  const sameFile = shownPath === path;
  shownPath = path;
  if (data.binary || data.tooLarge) {
    editor?.dispose(); editor = null; glyphs = null; shownPath = null;
    for (const model of previous) model.dispose();
    container.replaceChildren(element('div', 'diff-placeholder', data.binary ? 'Fichier binaire : pas de diff texte.' : 'Fichier trop volumineux pour être comparé ici.'));
    render();
    return;
  }
  if (!editor) container.replaceChildren();
  ensureEditor(container);
  const language = languageFor(path);
  const original = monaco.editor.createModel(data.original, language);
  const modified = monaco.editor.createModel(data.modified, language);
  models = [original, modified];
  // Même fichier réaffiché (après une indexation partielle) : on garde la position de lecture.
  const viewState = sameFile && previous.length ? editor.saveViewState() : null;
  editor.setModel({ original, modified });
  if (viewState) editor.restoreViewState(viewState);
  for (const model of previous) model.dispose();
  editor.updateOptions({ ...options(), readOnly: !data.editable });
  editor.getModifiedEditor().updateOptions({ readOnly: !data.editable, glyphMargin: Boolean(lines) });
  let saved = data.modified;
  current = {
    dirty: false,
    async save() {
      if (!data.editable || !onSave || !this.dirty) return;
      const text = modified.getValue();
      if (await onSave(text)) { saved = text; this.dirty = false; render(); current.partial?.decorate(); }
    },
    partial: lines && {
      busy: false,
      // Le diff envoyé est celui du disque (texte affiché et enregistré) : le service le compare au contenu actuel.
      async run(list, selection) {
        if (this.busy || current.dirty) return;
        this.busy = true;
        try {
          await lines.apply({ original: data.original, modified: saved, changes: list.map(({ raw, ...block }) => block), selection });
        } finally { this.busy = false; }
      },
      hunk(block) { return this.run(blocks(), hunkSelection(block)); },
      cursorHunk() {
        const list = blocks();
        const block = blockAtCursor(list);
        return this.run(list, block ? hunkSelection(block) : { original: [], modified: [] });
      },
      selectedLines() { const list = blocks(); return this.run(list, selectedLines(list)); },
      decorate() {
        const icon = lines.verb === 'Indexer' ? 'add' : 'remove';
        glyphs?.set(current.dirty ? [] : blocks().map((block) => ({
          range: new monaco.Range(glyphLine(block), 1, glyphLine(block), 1),
          options: { glyphMarginClassName: `codicon codicon-${icon} partial-glyph`, glyphMarginHoverMessage: { value: `${lines.verb} ce bloc` } },
        })));
      },
    },
  };
  if (lines) {
    for (const side of [editor.getOriginalEditor(), editor.getModifiedEditor()]) {
      partialDisposables.push(
        side.addAction({ id: 'workbench.partial.hunk', label: `${lines.verb} ce bloc`, contextMenuGroupId: '1_partial', contextMenuOrder: 1, run: () => current?.partial?.cursorHunk() }),
        side.addAction({ id: 'workbench.partial.lines', label: `${lines.verb} les lignes sélectionnées`, contextMenuGroupId: '1_partial', contextMenuOrder: 2, run: () => current?.partial?.selectedLines() }),
      );
    }
  } else glyphs?.clear();
  modified.onDidChangeContent(() => {
    const dirty = modified.getValue() !== saved;
    if (dirty !== current.dirty) { current.dirty = dirty; render(); current.partial?.decorate(); }
  });
  // Premier changement visible dès l'ouverture, une fois le diff calculé par le worker.
  if (!viewState) {
    const once = editor.onDidUpdateDiff(() => { once.dispose(); if (editor.getLineChanges()?.length) editor.goToDiff('next'); });
  }
  render();
}

export const diffIsDirty = () => Boolean(current?.dirty);

// Libère l'éditeur quand la vue disparaît (changement d'onglet de dépôt) ; il est recréé à la demande.
export function disposeDiff() {
  editor?.setModel(null);
  for (const disposable of partialDisposables) disposable.dispose();
  partialDisposables = [];
  editor?.dispose(); editor = null; glyphs = null; shownPath = null;
  for (const model of models) model.dispose();
  models = [];
  current = null;
}
