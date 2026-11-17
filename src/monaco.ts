// Monaco, l'éditeur de VS Code, chargé sans les services de langage (TypeScript, JSON, CSS, HTML) : ils exigent
// chacun un worker de plusieurs mégaoctets et n'apportent rien à la lecture d'un diff. La coloration syntaxique
// passe par les grammaires Monarch de toutes les langues, complétées par les grammaires TextMate des extensions VS Code
// (voir textmate.js) ; seul le worker de l'éditeur (calcul des diffs) est chargé, intégré au bundle pour fonctionner
// aussi depuis le paquet installé (file://).
// Liste reprise de monaco-editor/esm/vs/editor/editor.main.js (version figée dans package.json), sans les langages.
import * as monaco from 'monaco-esm/editor/editor.api.js';
import 'monaco-esm/languages/definitions/register.all.js';
import EditorWorker from 'monaco-esm/editor/editor.worker.js?worker&inline';
import 'monaco-esm/editor/contrib/anchorSelect/browser/anchorSelect.js';
import 'monaco-esm/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-esm/editor/contrib/caretOperations/browser/transpose.js';
import 'monaco-esm/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-esm/editor/contrib/codeAction/browser/codeActionContributions.js';
import 'monaco-esm/editor/browser/widget/codeEditor/codeEditorWidget.js';
import 'monaco-esm/editor/contrib/codelens/browser/codelensController.js';
import 'monaco-esm/base/browser/ui/codicons/codicon/codicon.css';
import 'monaco-esm/editor/contrib/colorPicker/browser/colorPickerContribution.js';
import 'monaco-esm/editor/contrib/comment/browser/comment.js';
import 'monaco-esm/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-esm/editor/contrib/cursorUndo/browser/cursorUndo.js';
import 'monaco-esm/editor/browser/widget/diffEditor/diffEditor.contribution.js';
import 'monaco-esm/editor/contrib/diffEditorBreadcrumbs/browser/contribution.js';
import 'monaco-esm/editor/contrib/dnd/browser/dnd.js';
import 'monaco-esm/editor/contrib/documentSymbols/browser/documentSymbols.js';
import 'monaco-esm/editor/contrib/dropOrPasteInto/browser/dropIntoEditorContribution.js';
import 'monaco-esm/features/find/register.js';
import 'monaco-esm/editor/contrib/floatingMenu/browser/floatingMenu.contribution.js';
import 'monaco-esm/editor/contrib/folding/browser/folding.js';
import 'monaco-esm/editor/contrib/fontZoom/browser/fontZoom.js';
import 'monaco-esm/editor/contrib/format/browser/formatActions.js';
import 'monaco-esm/editor/contrib/gotoError/browser/gotoError.js';
import 'monaco-esm/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js';
import 'monaco-esm/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js';
import 'monaco-esm/editor/contrib/gpu/browser/gpuActions.js';
import 'monaco-esm/editor/contrib/hover/browser/hoverContribution.js';
import 'monaco-esm/editor/contrib/indentation/browser/indentation.js';
import 'monaco-esm/editor/contrib/inlayHints/browser/inlayHintsContribution.js';
import 'monaco-esm/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution.js';
import 'monaco-esm/editor/contrib/inlineProgress/browser/inlineProgress.js';
import 'monaco-esm/editor/contrib/inPlaceReplace/browser/inPlaceReplace.js';
import 'monaco-esm/editor/contrib/insertFinalNewLine/browser/insertFinalNewLine.js';
import 'monaco-esm/editor/standalone/browser/inspectTokens/inspectTokens.js';
import 'monaco-esm/editor/standalone/browser/iPadShowKeyboard/iPadShowKeyboard.js';
import 'monaco-esm/editor/contrib/lineSelection/browser/lineSelection.js';
import 'monaco-esm/editor/contrib/linesOperations/browser/linesOperations.js';
import 'monaco-esm/editor/contrib/linkedEditing/browser/linkedEditing.js';
import 'monaco-esm/editor/contrib/links/browser/links.js';
import 'monaco-esm/editor/contrib/longLinesHelper/browser/longLinesHelper.js';
import 'monaco-esm/editor/contrib/middleScroll/browser/middleScroll.contribution.js';
import 'monaco-esm/editor/contrib/multicursor/browser/multicursor.js';
import 'monaco-esm/editor/contrib/parameterHints/browser/parameterHints.js';
import 'monaco-esm/editor/contrib/placeholderText/browser/placeholderText.contribution.js';
import 'monaco-esm/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js';
import 'monaco-esm/editor/standalone/browser/quickAccess/standaloneHelpQuickAccess.js';
import 'monaco-esm/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js';
import 'monaco-esm/editor/contrib/readOnlyMessage/browser/contribution.js';
import 'monaco-esm/editor/standalone/browser/referenceSearch/standaloneReferenceSearch.js';
import 'monaco-esm/editor/contrib/rename/browser/rename.js';
import 'monaco-esm/editor/contrib/sectionHeaders/browser/sectionHeaders.js';
import 'monaco-esm/editor/contrib/semanticTokens/browser/viewportSemanticTokens.js';
import 'monaco-esm/editor/contrib/smartSelect/browser/smartSelect.js';
import 'monaco-esm/editor/contrib/snippet/browser/snippetController2.js';
import 'monaco-esm/editor/contrib/stickyScroll/browser/stickyScrollContribution.js';
import 'monaco-esm/editor/contrib/suggest/browser/suggestInlineCompletions.js';
import 'monaco-esm/editor/standalone/browser/toggleHighContrast/toggleHighContrast.js';
import 'monaco-esm/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js';
import 'monaco-esm/editor/contrib/tokenization/browser/tokenization.js';
import 'monaco-esm/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter.js';
import 'monaco-esm/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators.js';
import 'monaco-esm/editor/contrib/wordHighlighter/browser/wordHighlighter.js';
import 'monaco-esm/editor/contrib/wordOperations/browser/wordOperations.js';
import 'monaco-esm/editor/contrib/wordPartOperations/browser/wordPartOperations.js';
import 'monaco-esm/editor/browser/coreCommands.js';
import 'monaco-esm/editor/contrib/caretOperations/browser/caretOperations.js';
import 'monaco-esm/editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js';
import 'monaco-esm/editor/contrib/find/browser/findController.js';
import 'monaco-esm/editor/contrib/gotoSymbol/browser/goToCommands.js';
import 'monaco-esm/editor/contrib/gotoError/browser/markerSelectionStatus.js';
import 'monaco-esm/editor/contrib/semanticTokens/browser/documentSemanticTokens.js';
import 'monaco-esm/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-esm/editor/common/standaloneStrings.js';
import 'monaco-esm/base/browser/ui/codicons/codicon/codicon-modifiers.css';
import { applyCatalog, fallbackLanguage, fileLanguage, loadCatalog, setFallback, themeRules } from './textmate.ts';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// Thème aux couleurs de l'application (fond bleu nuit, accent jaune, ajouts verts, suppressions rouges).
monaco.editor.defineTheme('workbench', {
  base: 'vs-dark',
  inherit: true,
  rules: themeRules,
  colors: {
    'editor.background': '#0a1124',
    'editor.lineHighlightBackground': '#13203a',
    'editorLineNumber.foreground': '#3d5a6e',
    'editorLineNumber.activeForeground': '#eee98a',
    'editorCursor.foreground': '#eee98a',
    'editor.selectionBackground': '#28455e',
    'editorGutter.background': '#0a1124',
    'diffEditor.insertedTextBackground': '#b7d97433',
    'diffEditor.removedTextBackground': '#bc596040',
    'diffEditor.insertedLineBackground': '#b7d97417',
    'diffEditor.removedLineBackground': '#bc59601f',
    'diffEditorGutter.insertedLineBackground': '#b7d97430',
    'diffEditorGutter.removedLineBackground': '#bc596038',
    'diffEditor.unchangedRegionBackground': '#101a30',
    'diffEditor.unchangedRegionForeground': '#81afb5',
    'editorWidget.background': '#14223a',
    'editorWidget.border': '#446374',
    'scrollbarSlider.background': '#28455ecc',
    'scrollbarSlider.hoverBackground': '#3a6079',
    'scrollbarSlider.activeBackground': '#4b7590',
    'scrollbar.shadow': '#00000000',
    'minimap.background': '#0a1124',
  },
});
monaco.editor.setTheme('workbench');

export { applyCatalog };

// Langage Monarch d'après l'extension (ou le nom) du fichier ; JSON utilise la grammaire JavaScript, faute de la sienne.
const EXTRA: Record<string, string> = { json: 'javascript', jsonc: 'javascript', cjs: 'javascript', mjs: 'javascript', svelte: 'html', vue: 'html', gradle: 'kotlin', kts: 'kotlin', toml: 'ini', properties: 'ini', env: 'shell', sk: 'python' };
function monarchLanguage(name: string): string | null {
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';
  if (name === 'makefile') return 'shell';
  const extension = name.includes('.') ? name.split('.').pop()! : '';
  if (EXTRA[extension]) return EXTRA[extension];
  const match = monaco.languages.getLanguages().find((language) => !language.id.startsWith('tm.') && language.extensions?.includes(`.${extension}`));
  return match?.id || null;
}

// Une extension installée ou importée l'emporte sur Monarch ; les grammaires intégrées à VS Code ne couvrent que les
// fichiers que Monarch ne sait pas colorer. Une grammaire qui échoue rend ses fichiers à Monarch.
export function languageFor(filePath: string) {
  return fileLanguage(filePath.split('/').pop()!.toLowerCase(), monarchLanguage);
}
setFallback((id: string) => fallbackLanguage(id, monarchLanguage));

// Grammaires des extensions VS Code : sans elles (aucune extension, lecture impossible, réponse trop lente), Monarch
// colore seul ; un catalogue arrivé en retard s'applique aux fichiers ouverts ensuite.
await loadCatalog(monaco, () => window.workbench.grammarCatalog());

export const baseOptions = {
  theme: 'workbench',
  automaticLayout: true,
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  fontSize: 12.5,
  lineHeight: 20,
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  renderWhitespace: 'selection',
  bracketPairColorization: { enabled: true },
  guides: { bracketPairs: 'active', indentation: true },
  stickyScroll: { enabled: true },
  padding: { top: 8 },
} satisfies monaco.editor.IStandaloneEditorConstructionOptions;

export { monaco };
