# Vérification Git Workbench MVP

## Plateforme vérifiée

- Hôte d’exécution : Debian GNU/Linux 13 (trixie), x86_64, noyau Linux 6.12.90.
- Node.js v22.22.3, npm 12.0.2, Git 2.47.3, Electron 39.8.10.
- Le build Linux unpacked et le lancement Electron avec `xvfb-run` ont été vérifiés sur cet hôte. Smoke test : `Desktop window and isolated preload loaded.`
- Cela ne constitue pas une certification de compatibilité ni une déclaration de support Debian 13. Aucune autre plateforme (Windows, macOS, autres distributions/architectures Linux) n’a été testée ici ; aucune n’est annoncée comme supportée.

## Preuves fonctionnelles

`node --test` passe 17 tests d’intégration sur des dépôts Git temporaires :

- Inspection en lecture seule, état des fichiers modifiés/non suivis/supprimés et lecture de l’historique.
- Détection des renommages avec le chemin de destination et preview du diff renommé.
- Preview du diff non suivi (y compris un chemin commençant par `-`), stage sélectif, preview du contenu indexé et unstage sans perte du working tree.
- Commit avec message non vide, uniquement les fichiers indexés ; message vide et index vide refusés.
- Hook `pre-commit` utilisateur exécuté.
- Création/changement de branches locales, préservation des modifications et refus d’un checkout dangereux par Git.
- Push vers upstream configuré et vérification de la référence distante ; rejet non-fast-forward et remote indisponible signalés comme échec/état indéterminé, jamais comme succès vérifié.
- Cherry-pick/rebase avec références locales de récupération ; conflit cherry-pick conservant la référence et indiquant `git cherry-pick --abort`.
- Conflit de rebase conservant la référence et indiquant `git rebase --abort`.
- Rebase interactif avec plan explicite et recovery ref ; plan malformé refusé.

Qualité/build exercés :

- `node scripts/lint.mjs` : syntaxe vérifiée sur 8 fichiers JavaScript.
- `npm run typecheck` : invariants du projet vérifiés (`private: true`, `license: UNLICENSED`).
- `npm run build` : Vite et electron-builder ont produit `artifacts/linux-unpacked` pour Linux x64.
- Smoke de la fenêtre empaquetée : `xvfb-run -a env GIT_WORKBENCH_SMOKE=1 ELECTRON_DISABLE_GPU=1 artifacts/linux-unpacked/git-workbench --no-sandbox --disable-gpu` — code 0.
- Limite de cet essai : pas de parcours manuel interactif de chaque contrôle UI ni de test de plateforme hors Debian 13 x86_64.

Dans cette session, la commande `npm run lint` via le wrapper terminal a retourné `ESLint output (JSON parse failed: EOF while parsing a value at line 1 column 0)` (code 1). En invoquant directement l’entrée npm sous-jacente (`node /home/hermes/.hermes/node/lib/node_modules/npm/bin/npm-cli.js run lint`), le script déclaré s’exécute et passe ; `node scripts/lint.mjs` passe aussi. Le lint lui-même est vérifié, mais l’anomalie du wrapper terminal est consignée plutôt que présentée comme un passage de `npm run lint`.

## Sécurité et confidentialité — limites explicites

- Le processus Git est lancé par `spawn('git', args, { shell: false })` ; les chemins de fichiers sont passés après `--`. Electron utilise `contextIsolation`, `sandbox`, `webSecurity`, `nodeIntegration: false`, navigation externe bloquée et CSP `connect-src 'none'`.
- Le code de l’application ne comporte pas de compte, télémétrie, API hébergée ni appel réseau applicatif. L’inspection, les diffs, stage/unstage et commits sont locaux. Les secrets ne sont pas écrits dans les journaux d’application.
- Un push est une exception volontaire et explicite : après confirmation, Git transmet les commits à l’upstream affiché. Git/SSH/credential helper configuré par l’utilisateur gère l’authentification ; l’app ne stocke ni n’affiche le token. Le push vérifie ensuite le hash de la branche distante via `git ls-remote`.
- Les hooks et credential helpers configurés restent actifs. Les hooks sont des programmes choisis par l’utilisateur et peuvent avoir leurs propres effets réseau ; ceux-ci ne sont pas sandboxés/garantis par Git Workbench. Aucune capture réseau avec proxy n’a été réalisée : la garantie ci-dessus repose sur l’inspection de la configuration et du code ainsi que sur les tests locaux, pas sur une observation exhaustive de toutes les extensions/hooks de l’utilisateur.
- Pas de force-push ; refus d’upstream modifié, de remote rejetant et remote indisponible. Le push indéterminé est signalé comme tel.

## Hors MVP / limites

- Stage/unstage par fichier entier seulement ; pas de staging partiel par hunk.
- Rebase interactif : actions `pick`, `drop`, `fixup` uniquement ; pas de reword/edit/squash.
- Pas de merge, fetch/pull automatique, résolution intégrée de conflits, force-push, opérations reset/discard/amend/squash, intégrations d’hébergeur, comptes, télémétrie ni distribution publique.
- Une référence `refs/git-workbench/recovery/...` est conservée avant cherry-pick/rebase. Après conflit, le dépôt reste dans l’état Git d’opération interrompue ; terminer avec Git ou utiliser la commande `--abort` indiquée dans le message.
