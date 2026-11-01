# ADR 0006 — Coloration par les grammaires TextMate des extensions VS Code

- Statut : accepté
- Date : 2026-11-01
- Décideur : Antoine
- Complète : l'ADR 0001 (Monaco chargé sans services de langage, coloration Monarch)

## Contexte

Le diff et l'éditeur se colorent avec les grammaires Monarch intégrées à Monaco. Elles ne couvrent
pas les langages plus récents ou plus rares (Astro, Prisma, BetonQuest…), que VS Code colore grâce
aux grammaires TextMate de ses extensions. L'utilisateur a souvent déjà ces extensions installées.

## Décision

- `vscode-textmate` tokenise dans la page avec le moteur Oniguruma (`vscode-oniguruma`, WebAssembly).
  Le fichier `onig.wasm` est livré avec l'application (dépendance d'exécution, listée dans
  `build.files`) et lu par le processus principal : aucun CDN, la CSP garde `connect-src 'none'` et
  n'ajoute que `'wasm-unsafe-eval'` à `script-src`.
- Trois provenances, de la moins à la plus prioritaire : grammaires intégrées à VS Code
  (`resources/app/extensions` de l'installation trouvée), extensions installées
  (`~/.vscode/extensions`, `~/.vscode-oss/extensions`), `.vsix` importés depuis le menu
  › « Extensions VS Code… ». Pour chaque extension, seule la version la plus récente non marquée
  `.obsolete` compte.
- Résolution d'un fichier : une extension installée ou importée l'emporte sur Monarch ; Monarch
  ensuite ; les grammaires intégrées à VS Code en dernier, pour les seuls fichiers que Monarch ne
  connaît pas. Elles servent aussi aux langages embarqués (TypeScript dans Astro…).
- Chaque langage TextMate devient un langage Monaco `tm.<id>` ; ses jetons portent le préfixe `tm.`
  et des couleurs Dark+ (la famille de vs-dark), sans toucher aux règles des grammaires Monarch.
- Un `.vsix` est une archive zip : le processus principal en extrait le manifeste, les grammaires et
  les configurations de langage dans `userData/vscode-extensions`, sans exécuter le moindre code de
  l'extension. La page désigne une grammaire par sa portée, jamais par un chemin.

## Alternatives écartées

- **Monarch seul** : il faudrait réécrire chaque grammaire à la main.
- **`monaco-textmate` / `monaco-editor-textmate`** : non maintenus et liés à `onigasm`, abandonné.
- **Grammaires intégrées de VS Code prioritaires sur Monarch** : la coloration Monarch actuelle est
  appréciée ; elle reste en place pour les langages qu'elle couvre.

## Conséquences

- Une ligne pathologique est tokenisée au plus 500 ms, puis laissée sans couleur.
- Après un import ou un retrait, la nouvelle coloration s'applique aux fichiers ouverts ensuite.
- Les grammaires sont des expressions régulières écrites par des tiers ; elles ne s'exécutent que
  dans le moteur Oniguruma de la page, isolée (`sandbox`, `contextIsolation`).
