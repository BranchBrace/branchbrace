import type { WorkbenchApi } from '../electron/preload.cts';
import type { StatusEntry, WorkingFile } from './git.ts';
import { baseOptions, languageFor, monaco } from './monaco.ts';

export interface EditorViewOptions {
  api: Pick<WorkbenchApi, 'listFiles' | 'readFile' | 'writeFile' | 'showFile'>;
  // Erreur à décrire, ou texte d'information quand `error` est nul.
  message: (error: unknown, text?: string) => unknown;
  confirm: (request: { title: string; message: string }) => Promise<boolean>;
  onSaved?: (filePath: string) => unknown;
  onShowDiff: (filePath: string) => unknown;
}
export interface EditorView {
  show(nextRoot: string, files: readonly StatusEntry[]): Promise<void>;
  updateStatus(files: readonly StatusEntry[]): void;
  open(filePath: string): Promise<void>;
  focusSearch(): void;
  dirtyCount(): number;
  reloadClean(filePath: string): Promise<void>;
  forget(closedRoot: string): void;
}

interface EditorState {
  tabs: string[];
  active: string | null;
  models: Map<string, monaco.editor.ITextModel>;
  // Version (alternative) du modèle au dernier enregistrement.
  saved: Map<string, number>;
  expanded: Set<string>;
  files: string[];
  filter: string;
  views: Map<string, monaco.editor.ICodeEditorViewState | null>;
}
interface TreeFile { name: string; path: string }
interface TreeDir extends TreeFile { dirs: Map<string, TreeDir>; files: TreeFile[] }

// Éditeur façon VS Code : explorateur de fichiers du dépôt (fichiers modifiés signalés comme dans Git), onglets,
// ouverture rapide Ctrl+P, enregistrement Ctrl+S. Il n'écrit que dans des fichiers texte existants du dépôt.
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const STATUS_CLASS: Record<string, string> = { M: 'modified', A: 'added', '?': 'untracked', D: 'deleted', R: 'added', '!': 'conflict' };

// Un état par dépôt ouvert : onglets, modèles Monaco et dossiers dépliés survivent au changement d'onglet de dépôt.
const states = new Map<string, EditorState>();
const stateFor = (root: string) => {
  if (!states.has(root)) states.set(root, { tabs: [], active: null, models: new Map(), saved: new Map(), expanded: new Set(), files: [], filter: '', views: new Map() });
  return states.get(root)!;
};

let editor: monaco.editor.IStandaloneCodeEditor | null = null;

// Arbre { dossiers, fichiers } construit à partir de la liste plate de chemins.
function buildTree(files: readonly string[]) {
  const root: TreeDir = { name: '', path: '', dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const dirPath = parts.slice(0, i + 1).join('/');
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], path: dirPath, dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i])!;
    }
    node.files.push({ name: parts.at(-1)!, path: file });
  }
  return root;
}

export function createEditorView(container: HTMLElement, { api, message, confirm, onSaved, onShowDiff }: EditorViewOptions): EditorView {
  const explorer = element('aside', 'explorer');
  const filter = element('input', 'text-input explorer-filter');
  filter.type = 'search'; filter.placeholder = 'Rechercher un fichier (Ctrl+P)'; filter.spellcheck = false;
  const tree = element('div', 'explorer-tree');
  explorer.append(element('div', 'explorer-title', 'EXPLORATEUR'), filter, tree);
  const main = element('section', 'editor-main');
  const tabs = element('div', 'editor-tabs');
  const crumbs = element('div', 'editor-crumbs');
  const surface = element('div', 'editor-surface');
  const empty = element('div', 'editor-empty');
  empty.append(element('div', 'empty-icon', '‹/›'), element('h2', '', 'Aucun fichier ouvert'), element('p', '', 'Choisissez un fichier dans l’explorateur ou tapez Ctrl+P. Ctrl+S enregistre dans le dossier du dépôt.'));
  main.append(tabs, crumbs, surface, empty);
  container.replaceChildren(explorer, main);

  // Dépôt affiché : fixé par `show` avant tout autre usage.
  let root: string | null = null;
  let status = new Map<string, string>();
  const state = () => stateFor(root!);

  const ensureEditor = () => {
    if (editor) return editor;
    editor = monaco.editor.create(surface, { ...baseOptions, model: null, minimap: { enabled: true, renderCharacters: false }, wordWrap: 'off' });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => { filter.focus(); filter.select(); });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () => { const { active } = state(); if (active) close(active); });
    return editor;
  };

  const isDirty = (filePath: string) => {
    const model = state().models.get(filePath);
    return Boolean(model) && model!.getAlternativeVersionId() !== state().saved.get(filePath);
  };

  const renderTabs = () => {
    const { tabs: open, active } = state();
    tabs.replaceChildren(...open.map((filePath) => {
      const tab = element('div', `editor-tab${filePath === active ? ' active' : ''}${isDirty(filePath) ? ' dirty' : ''}`);
      tab.title = filePath;
      const statusCode = status.get(filePath);
      const name = element('span', `editor-tab-name${statusCode ? ` git-${STATUS_CLASS[statusCode] || 'modified'}` : ''}`, filePath.split('/').pop()!);
      const closeButton = element('button', 'editor-tab-close', '×');
      closeButton.title = 'Fermer (Ctrl+W)';
      closeButton.addEventListener('click', (event) => { event.stopPropagation(); close(filePath); });
      tab.append(name, closeButton);
      tab.addEventListener('click', () => activate(filePath));
      tab.addEventListener('auxclick', (event) => { if (event.button === 1) close(filePath); });
      return tab;
    }));
    const showing = Boolean(active);
    empty.hidden = showing;
    surface.hidden = !showing;
    crumbs.hidden = !showing;
    if (active) {
      crumbs.replaceChildren(...active.split('/').flatMap((part, index, parts) => [element('span', index === parts.length - 1 ? 'crumb last' : 'crumb', part), index < parts.length - 1 ? element('span', 'crumb-sep', '›') : null].filter((node) => node !== null)));
      const tools = element('span', 'crumb-tools');
      if (status.has(active)) {
        const diff = element('button', 'chip-toggle', 'Voir le diff');
        diff.addEventListener('click', () => onShowDiff(active));
        tools.append(diff);
      }
      const reveal = element('button', 'chip-toggle', 'Afficher dans le dossier');
      reveal.addEventListener('click', () => api.showFile(root!, active));
      tools.append(reveal);
      if (isDirty(active)) tools.prepend(element('span', 'dirty-flag', '● non enregistré'));
      crumbs.append(tools);
    }
  };

  const renderTree = () => {
    const { files, expanded, active } = state();
    const needle = filter.value.trim().toLowerCase();
    if (needle) {
      // Recherche : liste plate des chemins correspondants, les noms de fichier exacts d'abord.
      const matches = files.filter((file) => file.toLowerCase().includes(needle))
        .sort((a, b) => Number(!a.split('/').pop()!.toLowerCase().includes(needle)) - Number(!b.split('/').pop()!.toLowerCase().includes(needle)) || a.length - b.length)
        .slice(0, 200);
      tree.replaceChildren(...matches.map((file, index) => fileRow({ name: file.split('/').pop()!, path: file }, 0, { folder: file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '', first: index === 0 })));
      if (!matches.length) tree.append(element('p', 'muted explorer-empty', 'Aucun fichier.'));
      return;
    }
    const rows: HTMLElement[] = [];
    const walk = (node: TreeDir, depth: number) => {
      for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const open = expanded.has(dir.path);
        const row = element('div', 'tree-row dir');
        row.style.paddingLeft = `${8 + depth * 12}px`;
        const changed = [...status.keys()].some((file) => file.startsWith(`${dir.path}/`));
        row.append(element('span', 'tree-chevron', open ? '▾' : '▸'), element('span', `tree-name${changed ? ' git-modified' : ''}`, dir.name));
        if (changed) row.append(element('span', 'tree-dot'));
        row.addEventListener('click', () => { if (open) expanded.delete(dir.path); else expanded.add(dir.path); renderTree(); });
        rows.push(row);
        if (open) walk(dir, depth + 1);
      }
      for (const file of node.files.sort((a, b) => a.name.localeCompare(b.name))) rows.push(fileRow(file, depth));
    };
    walk(buildTree(files), 0);
    tree.replaceChildren(...rows);
    tree.querySelector(`[data-path="${CSS.escape(active || '')}"]`)?.classList.add('active');
  };

  function fileRow(file: TreeFile, depth: number, { folder = '', first = false }: { folder?: string; first?: boolean } = {}) {
    const code = status.get(file.path);
    const row = element('div', `tree-row file${first ? ' first' : ''}`);
    row.dataset.path = file.path;
    row.style.paddingLeft = `${20 + depth * 12}px`;
    row.title = file.path;
    row.append(element('span', `tree-name${code ? ` git-${STATUS_CLASS[code] || 'modified'}` : ''}`, file.name));
    if (folder) row.append(element('span', 'tree-folder', folder));
    if (code) row.append(element('span', `tree-badge git-${STATUS_CLASS[code] || 'modified'}`, code === '?' ? 'U' : code));
    if (code === '!') row.title = `${file.path} — en conflit`;
    row.addEventListener('click', () => open(file.path));
    return row;
  }

  async function open(filePath: string) {
    const current = state();
    if (!current.models.has(filePath)) {
      let result: WorkingFile;
      try { result = await api.readFile(root!, filePath); }
      catch (error) { message(error); return; }
      if (result.binary || result.tooLarge) { message(null, result.binary ? 'Fichier binaire : il ne s’ouvre pas dans l’éditeur.' : 'Fichier trop volumineux pour l’éditeur (plus de 5 Mo).'); return; }
      const model = monaco.editor.createModel(result.content, languageFor(filePath));
      current.models.set(filePath, model);
      current.saved.set(filePath, model.getAlternativeVersionId());
      model.onDidChangeContent(() => renderTabs());
    }
    if (!current.tabs.includes(filePath)) current.tabs.push(filePath);
    activate(filePath);
    for (let index = filePath.indexOf('/'); index > 0; index = filePath.indexOf('/', index + 1)) current.expanded.add(filePath.slice(0, index));
    renderTree();
  }

  function activate(filePath: string | null) {
    const current = state();
    if (current.active && editor) current.views.set(current.active, editor.saveViewState());
    current.active = filePath;
    renderTabs();
    if (!filePath) { editor?.setModel(null); return; }
    const codeEditor = ensureEditor();
    codeEditor.setModel(current.models.get(filePath) ?? null);
    const view = current.views.get(filePath);
    if (view) codeEditor.restoreViewState(view);
    codeEditor.focus();
    tree.querySelectorAll('.tree-row.active').forEach((row) => row.classList.remove('active'));
    tree.querySelector(`[data-path="${CSS.escape(filePath)}"]`)?.classList.add('active');
  }

  async function close(filePath: string) {
    const current = state();
    if (isDirty(filePath) && !await confirm({ title: 'Fermer sans enregistrer ?', message: `${filePath} contient des modifications non enregistrées. Elles seront perdues.` })) return;
    const index = current.tabs.indexOf(filePath);
    current.tabs.splice(index, 1);
    if (current.active === filePath) activate(current.tabs[Math.min(index, current.tabs.length - 1)] ?? null);
    current.models.get(filePath)?.dispose();
    current.models.delete(filePath);
    current.saved.delete(filePath);
    current.views.delete(filePath);
    renderTabs();
  }

  async function save() {
    const current = state();
    const filePath = current.active;
    if (!filePath || !isDirty(filePath)) return;
    const model = current.models.get(filePath)!;
    const version = model.getAlternativeVersionId();
    try { await api.writeFile(root!, filePath, model.getValue()); }
    catch (error) { message(error); return; }
    current.saved.set(filePath, version);
    renderTabs();
    message(null, `${filePath} enregistré.`);
    onSaved?.(filePath);
  }

  filter.addEventListener('input', () => renderTree());
  filter.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { const first = tree.querySelector<HTMLElement>('.tree-row.file'); if (first) { open(first.dataset.path!); filter.value = ''; renderTree(); } }
    if (event.key === 'Escape') { filter.value = ''; renderTree(); editor?.focus(); }
  });

  return {
    // Affiche l'éditeur pour ce dépôt et recharge la liste des fichiers ; `files` vient de `git status` (marqueurs).
    async show(nextRoot, files) {
      if (root !== nextRoot && state && root) { const current = state(); if (current.active && editor) current.views.set(current.active, editor.saveViewState()); }
      root = nextRoot;
      this.updateStatus(files);
      try { state().files = await api.listFiles(nextRoot); }
      catch (error) { message(error); }
      renderTree();
      activate(state().active);
    },
    updateStatus(files) {
      status = new Map(files.map((file): [string, string] => [file.path, file.conflicted ? '!' : file.untracked ? '?' : (file.worktreeStatus !== ' ' ? file.worktreeStatus : file.indexStatus)]));
      if (root) { renderTree(); renderTabs(); }
    },
    open,
    focusSearch() { filter.focus(); filter.select(); },
    // Fichiers modifiés et non enregistrés, tous dépôts confondus (avant de fermer la fenêtre).
    dirtyCount() {
      let count = 0;
      for (const current of states.values()) for (const [filePath, model] of current.models) if (model.getAlternativeVersionId() !== current.saved.get(filePath)) count += 1;
      return count;
    },
    // Le fichier a changé sur disque (diff enregistré, conflit résolu) : relit les onglets ouverts non modifiés.
    async reloadClean(filePath) {
      const current = state();
      const model = current.models.get(filePath);
      if (!model || isDirty(filePath)) return;
      try {
        const result = await api.readFile(root!, filePath);

        if (result.content !== null && result.content !== model.getValue()) { model.setValue(result.content); current.saved.set(filePath, model.getAlternativeVersionId()); renderTabs(); }
      } catch { /* fichier supprimé : l'onglet garde son contenu */ }
    },
    forget(closedRoot) {
      const current = states.get(closedRoot);
      if (!current) return;
      if (root === closedRoot) editor?.setModel(null);
      for (const model of current.models.values()) model.dispose();
      states.delete(closedRoot);
    },
  };
}
