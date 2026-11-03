import { element, modal } from './dialogs.ts';
import { describeError } from './errors.ts';
import type { CatalogExtension, ExtensionSource, GrammarCatalog } from './grammar-catalog.ts';

// Fenêtre « Extensions VS Code » : grammaires de coloration détectées dans VS Code, import d'un .vsix et retrait des
// extensions importées. Le catalogue mis à jour est appliqué à Monaco pour les fichiers ouverts ensuite.

const languagesOf = (extension: CatalogExtension) => extension.languages.join(', ') || 'grammaires embarquées';

async function apply(catalog: GrammarCatalog) {
  const { applyCatalog, monaco } = await import('./monaco.ts');
  applyCatalog(monaco, catalog);
}

export async function openExtensions(): Promise<true | null> {
  let catalog = await window.workbench.grammarCatalog();
  const imported = element('ul', 'extension-list');
  const installed = element('ul', 'extension-list');
  const builtin = element('p', 'dialog-hint');
  const result = element('div', 'update-result');
  result.hidden = true;
  const show = (text: string, tone = '') => { result.hidden = false; result.className = `update-result ${tone}`; result.textContent = text; };

  const row = (extension: CatalogExtension, action?: HTMLElement) => {
    const item = element('li', 'extension-item');
    const text = element('span', 'extension-text');
    text.append(element('strong', '', extension.name), element('span', 'extension-meta', ` ${extension.version} · ${languagesOf(extension)}`));
    item.append(text);
    if (action) item.append(action);
    return item;
  };
  const render = () => {
    const of = (source: ExtensionSource) => catalog.extensions.filter((extension) => extension.source === source);
    imported.replaceChildren(...of('imported').map((extension) => {
      const remove = element('button', 'button secondary', 'Retirer');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try { catalog = await window.workbench.removeExtension(extension.id); await apply(catalog); show(`${extension.name} retirée.`, 'ok'); render(); }
        catch (error) { remove.disabled = false; show(describeError(error), 'error'); }
      });
      return row(extension, remove);
    }));
    if (!imported.children.length) imported.append(element('li', 'extension-empty', 'Aucune extension importée.'));
    installed.replaceChildren(...of('installed').map((extension) => row(extension)));
    if (!installed.children.length) installed.append(element('li', 'extension-empty', 'Aucune extension avec grammaire trouvée dans ~/.vscode/extensions ni ~/.vscode-oss/extensions.'));
    const count = of('builtin').length;
    builtin.textContent = count
      ? `${count} extensions intégrées à VS Code complètent la coloration des langages que l’éditeur ne connaît pas.`
      : 'VS Code n’a pas été trouvé : seules les extensions ci-dessus complètent la coloration.';
  };

  const importButton = element('button', 'button primary', 'Importer un .vsix…');
  importButton.type = 'button';
  importButton.addEventListener('click', async () => {
    importButton.disabled = true;
    try {
      const outcome = await window.workbench.importExtension();
      if (outcome) {
        catalog = outcome.catalog;
        await apply(catalog);
        show(`${outcome.imported.name} ${outcome.imported.version} importée : elle colore les fichiers ouverts à partir de maintenant.`, 'ok');
        render();
      }
    } catch (error) { show(describeError(error), 'error'); }
    finally { importButton.disabled = false; }
  });
  const actions = element('div', 'update-actions');
  actions.append(importButton);

  const section = (title: string, list: HTMLElement) => {

    const field = element('div', 'dialog-field');
    field.append(element('span', 'eyebrow', title), list);
    return field;
  };
  render();
  const hint = element('p', 'dialog-hint', 'Les grammaires TextMate des extensions colorent le diff et l’éditeur ; elles priment sur la coloration intégrée pour les langages qu’elles couvrent. Lecture locale uniquement : rien n’est téléchargé.');
  return modal('Extensions VS Code', [hint, section('IMPORTÉES', imported), actions, result, section('DÉTECTÉES DANS VS CODE', installed), builtin],
    { confirmLabel: 'Fermer', cancelLabel: null, collect: () => true });
}
