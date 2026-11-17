import { element, modal } from './dialogs.ts';

function choice(type: 'checkbox' | 'radio', name: string, text: string, { checked = false, disabled = false } = {}) {
  const input = element('input');
  input.type = type;
  input.name = name;
  input.checked = checked;
  input.disabled = disabled;
  const label = element('label', 'dialog-choice');
  label.append(input, element('span', '', text));
  return { input, label };
}

// Prévisualisation d'un merge : les commits qui entreront dans la branche courante, puis le mode. Un commit de merge
// par défaut ; le fast-forward n'est proposé que si Git peut simplement avancer la branche. Renvoie { fastForward } ou null.
// Ce que le dialogue lit de la prévisualisation renvoyée par le processus principal.
interface MergePreviewView {
  commits: readonly { shortHash: string; subject: string; author: string }[];
  total: number;
  fastForward: boolean;
}

export function confirmMerge({ source, branch, preview }: { source: string; branch: string; preview: MergePreviewView }) {
  const list = element('ol', 'merge-commits');
  for (const commit of preview.commits) {
    const item = element('li');
    item.append(element('code', '', commit.shortHash), element('span', '', commit.subject), element('small', '', commit.author));
    list.append(item);
  }
  const body: HTMLElement[] = [element('p', 'dialog-hint', `${preview.total} commit${preview.total > 1 ? 's' : ''} de « ${source} » entrer${preview.total > 1 ? 'ont' : 'a'} dans « ${branch} » :`), list];
  if (preview.total > preview.commits.length) body.push(element('p', 'dialog-hint', `… et ${preview.total - preview.commits.length} commits plus anciens.`));
  const option = choice('checkbox', 'fast-forward', preview.fastForward
    ? `Fast-forward : avancer « ${branch} » sans commit de merge`
    : 'Fast-forward impossible : les deux branches ont divergé', { disabled: !preview.fastForward });
  body.push(option.label, element('p', 'dialog-hint', 'Un point de reprise local est enregistré avant le merge. En cas de conflit, résolvez les fichiers puis continuez, ou annulez le merge.'));
  return modal(`Merger « ${source} » dans « ${branch} » ?`, body, { confirmLabel: 'Merger', collect: () => ({ fastForward: option.input.checked }) });
}

// Pull refusé parce que la branche a divergé de son upstream : rien n'a été intégré. On explique l'écart et on laisse
// choisir merge ou rebase sur l'upstream ; chacun passe ensuite par sa propre prévisualisation. Renvoie 'merge', 'rebase' ou null.
export function chooseIntegration({ branch, upstream, ahead, behind }: { branch: string; upstream: string; ahead: number; behind: number }) {
  const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? 's' : ''}`;
  const merge = choice('radio', 'integration', `Merger « ${upstream} » dans « ${branch} » (commit de merge)`, { checked: true });
  const rebase = choice('radio', 'integration', `Rebaser « ${branch} » sur « ${upstream} » (réécrit vos ${plural(ahead, 'commit')} locaux)`);
  const body = [
    element('p', 'dialog-message', `« ${branch} » a ${plural(ahead, 'commit')} absent${ahead > 1 ? 's' : ''} de « ${upstream} », qui en a ${behind} que vous n’avez pas. Un fast-forward est impossible : rien n’a été intégré.`),
    merge.label, rebase.label,
    element('p', 'dialog-hint', 'L’opération choisie affiche d’abord ce qu’elle va faire, avant toute modification.'),
  ];
  return modal('Branche divergente', body, { confirmLabel: 'Continuer…', collect: () => (rebase.input.checked ? 'rebase' : 'merge') });
}
