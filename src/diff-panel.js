import { baseOptions, languageFor, monaco } from './monaco.js';

// Vue centrale de diff : éditeur de diff Monaco (côte à côte ou en ligne, zones inchangées repliables, surlignage
// au mot près). Pour un fichier non indexé, le côté droit est le fichier de travail lui-même : modifiable, Ctrl+S
// l'enregistre.
const PREFS_KEY = 'git-workbench.diff';
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

// Blocs indexables affichés en CodeLens au-dessus de chaque zone modifiée (« Indexer ce bloc »). Masqués tant que
// le fichier est modifié sans être enregistré : leurs positions sont celles du fichier sur disque.
let hunkLenses = null;
const hunksChanged = new monaco.Emitter();
const HUNK_COMMAND = 'git-workbench.toggle-hunk';
monaco.editor.registerCommand(HUNK_COMMAND, (_accessor, hunk) => hunkLenses?.onToggle(hunk));
monaco.languages.registerCodeLensProvider('*', {
  onDidChange: hunksChanged.event,
  provideCodeLenses(model) {
    if (!hunkLenses || model !== models[1] || current?.dirty) return { lenses: [], dispose() {} };
    const last = model.getLineCount();
    const lenses = hunkLenses.list.map((hunk) => {
      // Un bloc de pure suppression n'a pas de ligne côté droit : sa lentille se place sous la ligne qui le précède.
      const line = Math.min(last, Math.max(1, hunk.newCount ? hunk.newStart : hunk.newStart + 1));
      return { range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, command: { id: HUNK_COMMAND, title: hunkLenses.staged ? '− Désindexer ce bloc' : '+ Indexer ce bloc', arguments: [hunk] } };
    });
    return { lenses, dispose() {} };
  },
});

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
  return editor;
}

const toggle = (label, title, active, onClick) => {
  const button = element('button', `chip-toggle${active ? ' active' : ''}`, label);
  button.title = title;
  button.setAttribute('aria-pressed', String(active));
  button.addEventListener('click', onClick);
  return button;
};

// `data` : { original, modified, existsBefore, existsAfter, editable } ou { binary } / { tooLarge }.
// `actions` : boutons propres au contexte (indexer, ouvrir dans l'éditeur…) ; `onSave(texte)` si modifiable.
// `hunks` : { list, staged, onToggle(bloc) } pour indexer ou désindexer bloc par bloc, ou null.
export function showDiff(container, toolbar, { path, data, actions = [], onSave, hunks = null }) {
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
    if (current?.dirty) tools.push(element('span', 'dirty-flag', '● non enregistré — Ctrl+S'));
    toolbar.replaceChildren(...tools, ...actions);
  };
  const apply = () => { savePrefs(); editor?.updateOptions(options()); render(); };

  // Les anciens modèles ne sont libérés qu'une fois détachés de l'éditeur.
  const previous = models;
  models = [];
  current = null;
  hunkLenses = hunks;
  if (data.binary || data.tooLarge) {
    editor?.dispose(); editor = null;
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
  editor.setModel({ original, modified });
  for (const model of previous) model.dispose();
  editor.updateOptions({ ...options(), readOnly: !data.editable });
  editor.getModifiedEditor().updateOptions({ readOnly: !data.editable });
  let saved = data.modified;
  current = {
    dirty: false,
    async save() {
      if (!data.editable || !onSave || !this.dirty) return;
      const text = modified.getValue();
      if (!await onSave(text)) return;
      saved = text; this.dirty = false; render();
      // Les blocs suivent le fichier enregistré : on les recalcule, si ce diff est toujours celui affiché.
      if (hunks?.reload && hunkLenses === hunks) {
        const list = await hunks.reload();
        if (hunkLenses === hunks) { hunks.list = list; hunksChanged.fire(); }
      }
    },
  };
  modified.onDidChangeContent(() => {
    const dirty = modified.getValue() !== saved;
    if (dirty !== current.dirty) { current.dirty = dirty; render(); hunksChanged.fire(); }
  });
  hunksChanged.fire();
  // Premier changement visible dès l'ouverture, une fois le diff calculé par le worker.
  const once = editor.onDidUpdateDiff(() => { once.dispose(); if (editor.getLineChanges()?.length) editor.goToDiff('next'); });
  render();
}

export const diffIsDirty = () => Boolean(current?.dirty);

// Libère l'éditeur quand la vue disparaît (changement d'onglet de dépôt) ; il est recréé à la demande.
export function disposeDiff() {
  hunkLenses = null;
  editor?.setModel(null);
  editor?.dispose(); editor = null;
  for (const model of models) model.dispose();
  models = [];
  current = null;
}
