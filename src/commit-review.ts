import { baseOptions, languageFor, monaco } from './monaco.ts';
import { diffPrefs, saveDiffPrefs } from './diff-panel.ts';
import type { DiffPrefs } from './diff-panel.ts';
import type { CommitDetails, CommitFile, FileVersions } from './git.ts';

export interface ReviewOptions {
  details: CommitDetails;
  focusPath?: string | null;
  // Les deux versions d'un fichier du commit ; rien si elles n'ont pas pu être lues.
  load: (path: string) => Promise<FileVersions | null | undefined>;
  onOpenFile: (path: string) => unknown;
}

interface ReviewCard {
  file: CommitFile;
  node: HTMLElement;
  body: HTMLDivElement;
  editor: monaco.editor.IStandaloneDiffEditor | null;
  models: monaco.editor.ITextModel[];
  collapsed: boolean;
  loading: boolean;
  toggle: () => void;
}

// Revue d'un commit : tous les fichiers modifiés l'un sous l'autre, chacun avec son diff replié sur les zones
// changées, comme une page de revue de pull request. Un diff n'est chargé qu'à l'approche de l'écran.
const STATUS: Record<string, string> = { A: 'Ajouté', M: 'Modifié', D: 'Supprimé', R: 'Renommé', C: 'Copié', T: 'Type changé' };
const LINE = 20;
const BLOCKS = 5;

let cards: ReviewCard[] = [];
let observer: IntersectionObserver | null = null;
let shown: string | null = null;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? 's' : ''}`;

const editorOptions = (): monaco.editor.IDiffEditorOptions => ({
  renderSideBySide: diffPrefs.sideBySide,
  wordWrap: diffPrefs.wrap ? 'on' : 'off',
  diffWordWrap: diffPrefs.wrap ? 'on' : 'off',
});

export function disposeReview(): void {
  observer?.disconnect();
  observer = null;
  for (const card of cards) {
    card.editor?.setModel(null);
    card.editor?.dispose();
    for (const model of card.models) model.dispose();
  }
  cards = [];
  shown = null;
}

// Fait défiler la revue jusqu'à un fichier et le met en évidence un instant.
export function revealReviewFile(path: string): boolean {
  const card = cards.find((item) => item.file.path === path);
  if (!card) return false;
  if (card.collapsed) card.toggle();
  card.node.scrollIntoView({ block: 'start', behavior: 'smooth' });
  card.node.classList.remove('flash');
  void card.node.offsetWidth;
  card.node.classList.add('flash');
  return true;
}

export const reviewedCommit = (): string | null => shown;

function stat(file: CommitFile) {
  const box = element('span', 'review-stat');
  if (file.binary) { box.append(element('span', 'muted', 'binaire')); return box; }
  box.append(element('span', 'plus', `+${file.additions || 0}`), element('span', 'minus', `−${file.deletions || 0}`));
  const blocks = element('span', 'blocks');
  const total = (file.additions || 0) + (file.deletions || 0);
  const green = total ? Math.round(((file.additions || 0) / total) * BLOCKS) : 0;
  for (let i = 0; i < BLOCKS; i += 1) blocks.append(element('i', total === 0 ? '' : i < green ? 'plus' : 'minus'));
  box.append(blocks);
  return box;
}

// `details` : le détail du commit (message, auteur, fichiers) ; `load(path)` renvoie les deux versions d'un fichier.
export function showReview(container: HTMLElement, toolbar: HTMLElement, { details, focusPath, load, onOpenFile }: ReviewOptions): void {
  disposeReview();
  shown = details.hash;
  const scroller = element('div', 'review-scroll');
  const [subject, ...body] = details.message.split('\n');
  const head = element('header', 'review-head');
  head.append(element('h2', '', subject));
  const description = body.join('\n').trim();
  if (description) head.append(element('p', 'review-body', description));
  const additions = details.files.reduce((sum, file) => sum + (file.additions || 0), 0);
  const deletions = details.files.reduce((sum, file) => sum + (file.deletions || 0), 0);
  const meta = element('div', 'review-meta');
  meta.append(element('code', 'sha-chip', details.hash.slice(0, 7)), `${details.author} · ${new Date(details.authorDate).toLocaleString('fr-FR')} · `, element('strong', '', plural(details.files.length, 'fichier')), ' ', element('span', 'plus', `+${additions}`), ' ', element('span', 'minus', `−${deletions}`));
  head.append(meta);
  const list = element('div', 'review-files');
  scroller.append(head, list);
  if (!details.files.length) list.append(element('p', 'muted review-note', 'Ce commit ne modifie aucun fichier.'));
  container.replaceChildren(scroller);

  const mount = async (card: ReviewCard) => {
    if (card.loading || card.collapsed) return;
    card.loading = true;
    const data = await load(card.file.path);
    if (!cards.includes(card)) return;
    if (!data || data.binary || data.tooLarge) {
      card.body.replaceChildren(element('div', 'review-note', !data ? 'Diff indisponible.' : data.binary ? 'Fichier binaire : pas de diff texte.' : 'Fichier trop volumineux pour être comparé ici.'));
      card.body.style.height = '';
      return;
    }
    const language = languageFor(card.file.path);
    const original = monaco.editor.createModel(data.original ?? '', language);
    const modified = monaco.editor.createModel(data.modified ?? '', language);
    card.models = [original, modified];
    card.body.replaceChildren();
    const editor = monaco.editor.createDiffEditor(card.body, {
      ...baseOptions,
      ...editorOptions(),
      readOnly: true,
      originalEditable: false,
      useInlineViewWhenSpaceIsLimited: false,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4, revealLineCount: 20 },
      diffAlgorithm: 'advanced',
      ignoreTrimWhitespace: false,
      renderMarginRevertIcon: false,
      renderOverviewRuler: false,
      enableSplitViewResizing: false,
      minimap: { enabled: false },
      stickyScroll: { enabled: false },
      padding: { top: 4, bottom: 4 },
      // Hauteur ajustée au contenu : la molette fait défiler la page, pas l'éditeur.
      scrollbar: { vertical: 'hidden', horizontalScrollbarSize: 8, alwaysConsumeMouseWheel: false },
    });
    editor.setModel({ original, modified });
    card.editor = editor;
    const fit = () => {
      const height = Math.max(editor.getOriginalEditor().getContentHeight(), editor.getModifiedEditor().getContentHeight());
      card.body.style.height = `${Math.min(height, 6000) + 10}px`;
    };
    editor.getOriginalEditor().onDidContentSizeChange(fit);
    editor.getModifiedEditor().onDidContentSizeChange(fit);
    editor.onDidUpdateDiff(fit);
    fit();
  };

  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) mount(cards.find((card) => card.node === entry.target)!);
  }, { root: scroller, rootMargin: '800px 0px' });

  for (const file of details.files) {
    const node = element('section', `review-file change-${file.status}`);
    const header = element('div', 'review-file-head');
    header.tabIndex = 0;
    const chevron = element('span', 'review-chevron', '▾');
    const badge = element('span', `change-badge change-${file.status}`, file.status);
    badge.title = STATUS[file.status] || file.status;
    const slash = file.path.lastIndexOf('/');
    const names = element('span', 'review-names');
    if (file.originalPath) names.append(element('span', 'file-folder', `${file.originalPath} →`));
    else if (slash >= 0) names.append(element('span', 'file-folder', file.path.slice(0, slash + 1)));
    names.append(element('span', 'file-name', file.path.slice(slash + 1)));
    const open = element('button', 'chip-toggle', 'Ouvrir seul');
    open.title = 'Afficher ce fichier seul, en plein écran';
    open.addEventListener('click', (event) => { event.stopPropagation(); onOpenFile(file.path); });
    header.append(chevron, badge, names, stat(file), open);
    const content = element('div', 'review-file-body');
    content.style.height = `${Math.min((file.additions || 0) + (file.deletions || 0) + 8, 40) * LINE}px`;
    node.append(header, content);
    list.append(node);
    const card: ReviewCard = {
      file, node, body: content, editor: null, models: [], collapsed: false, loading: false,
      toggle: () => {
        card.collapsed = !card.collapsed;
        node.classList.toggle('collapsed', card.collapsed);
        if (!card.collapsed) mount(card);
      },
    };
    header.addEventListener('click', card.toggle);
    header.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); card.toggle(); } });
    cards.push(card);
    observer.observe(node);
  }

  const toggle = (label: string, title: string, active: boolean, onClick: () => void) => {
    const button = element('button', `chip-toggle${active ? ' active' : ''}`, label);
    button.title = title;
    button.setAttribute('aria-pressed', String(active));
    button.addEventListener('click', onClick);
    return button;
  };
  const renderTools = () => {
    const layout = element('span', 'segmented');
    layout.append(
      toggle('Côte à côte', 'Ancienne version à gauche, nouvelle à droite', diffPrefs.sideBySide, () => apply({ sideBySide: true })),
      toggle('En ligne', 'Suppressions et ajouts dans un seul fichier', !diffPrefs.sideBySide, () => apply({ sideBySide: false })),
    );
    const fold = element('span', 'segmented');
    const all = (collapse: boolean) => () => { for (const card of cards) if (card.collapsed !== collapse) card.toggle(); };
    fold.append(toggle('Tout replier', 'Ne garder que la liste des fichiers', false, all(true)), toggle('Tout déplier', 'Afficher le diff de chaque fichier', false, all(false)));
    toolbar.replaceChildren(layout, toggle('↵', 'Retour à la ligne automatique', diffPrefs.wrap, () => apply({ wrap: !diffPrefs.wrap })), fold);
  };
  const apply = (change: Partial<DiffPrefs>) => {

    Object.assign(diffPrefs, change);
    saveDiffPrefs();
    for (const card of cards) card.editor?.updateOptions(editorOptions());
    renderTools();
  };
  renderTools();
  if (focusPath) requestAnimationFrame(() => revealReviewFile(focusPath));
}
