# Vérification Git Workbench MVP

## Plateforme vérifiée

- Hôte d’exécution : Debian GNU/Linux 13 (trixie), x86_64, noyau Linux 6.12.90.
- Node.js v22.22.3, npm 12.0.2, Git 2.47.3, Electron 39.8.10.
- Le build Linux unpacked et le lancement Electron avec `xvfb-run` ont été vérifiés sur cet hôte. Smoke test : `Desktop window and isolated preload loaded.`
- Cela ne constitue pas une certification de compatibilité ni une déclaration de support Debian 13. Aucune autre plateforme (Windows, macOS, autres distributions/architectures Linux) n’a été testée ici ; aucune n’est annoncée comme supportée.

## Preuves fonctionnelles

`npm test` passe 18 tests d’intégration sur des dépôts Git temporaires et un remote bare local :

- Inspection en lecture seule, état des fichiers modifiés/non suivis/supprimés et lecture de l’historique.
- Détection des renommages avec le chemin de destination et preview du diff renommé.
- Preview du diff non suivi (y compris un chemin commençant par `-`), stage sélectif, preview du contenu indexé et unstage sans perte du working tree.
- Commit avec message non vide, uniquement les fichiers indexés ; message vide et index vide refusés.
- Hook `pre-commit` utilisateur exécuté.
- Création/changement de branches locales, préservation des modifications et refus d’un checkout dangereux par Git.
- Push vers upstream configuré et vérification de la référence distante ; rejet non-fast-forward, remote indisponible et perte d’accusé de réception après acceptation distante signalés comme échec/état indéterminé, jamais comme succès vérifié. Le dernier scénario vérifie la référence du remote et l’arbre local avant/après.
- Cherry-pick/rebase avec références locales de récupération ; conflit cherry-pick conservant la référence et indiquant `git cherry-pick --abort`.
- Conflit de rebase conservant la référence et indiquant `git rebase --abort`.
- Rebase interactif avec plan explicite et recovery ref ; plan malformé refusé.

Qualité/build exercés dans l’environnement courant :

- `npm test` : 18/18 tests passés (commande exécutée le 2026-10-31) ; au 2026-10-31 après MON-643 : 22/22 (19 tests d’intégration Git + 3 tests de packaging).
- `npm run lint` et `npm run typecheck` via l’entrée npm directe : les deux scripts déclarés passent ; lint vérifie 8 fichiers JavaScript et typecheck les invariants du projet (`private: true`, `license: UNLICENSED`).
- `npm run build` : Vite 7.3.7 et electron-builder 26.18.0 ont produit `artifacts/linux-unpacked` pour Linux x64 avec Electron 39.8.10.
- Smoke de la fenêtre empaquetée : `xvfb-run -a env GIT_WORKBENCH_SMOKE=1 ELECTRON_DISABLE_GPU=1 artifacts/linux-unpacked/git-workbench --no-sandbox --disable-gpu` — code 0.
- Limite de cet essai : pas de parcours manuel interactif de chaque contrôle UI ni de test de plateforme hors Debian 13 x86_64. Windows 10+ x64, macOS 12+ Intel/Apple Silicon, Ubuntu 22.04 x86_64 et Debian 12 x86_64 ne sont pas testés et ne sont pas déclarés supportés.

Le wrapper terminal a d’abord mal parsé la sortie de lint (`ESLint output (JSON parse failed: EOF while parsing a value at line 1 column 0)`, code 1) ; le contrôle a été repris par l’entrée npm directe, avec succès. Il s’agit de vérifications locales, pas d’une exécution GitHub Actions. La build candidate actuelle est un répertoire Linux x64 unpacked (284 MiB) dans `artifacts/linux-unpacked`; le smoke test empaqueté sous `xvfb-run` retourne `Desktop window and isolated preload loaded.` (code 0). Aucun artefact Windows/macOS n’a été produit sur cet hôte Linux.

## Installateur Linux x64 (`.deb`) — MON-643

Format retenu : paquet Debian x64 (voir `docs/adr/0002-linux-installer.md`). Vérifié le 2026-10-31 :

- Build : `npm run package:linux -- -c.extraMetadata.version=1.0.0-rc.1` depuis le commit `477a50e` (= `v1.0.0-rc.1` + ajout du packaging et du smoke installateur) ; electron-builder 26.18.0, fpm 1.17.0 (outil téléchargé par electron-builder), Electron 39.8.10. Sortie : `git-workbench_1.0.0-rc.1_amd64.deb`, 90 864 596 octets, version Debian `1.0.0~rc.1`, arch `amd64`, dépendance `git` déclarée.
- SHA-256 : `0c44b6dec313e295d4427af715a1ef59a5ae225bb9bfbbf66b1515dbb98e6359`.
- Smoke : `sh scripts/smoke-linux-installer.sh <deb>` — conteneur jetable `debian:trixie` (`sha256:2dc419c6d7fe3dad0a2f9fd469c34cc90b0f9ba642d8fde837fe3d7d34a0e7f1`), Docker 26.1.5, x86_64. Le script vérifie la somme, installe via `apt-get install ./…deb` (résolution des dépendances), contrôle `dpkg -s`, le lanceur `/usr/bin/git-workbench` et l’entrée `git-workbench.desktop`, lance l’application installée sous `xvfb-run` en utilisateur non root avec le sandbox Chromium actif (`chrome-sandbox` 755, espaces de noms utilisateur ; jamais `--no-sandbox`), lit un dépôt Git jetable via le pont preload → IPC → Git CLI, puis `apt-get purge` et contrôle l’absence de `/opt/Git Workbench`, du lanceur et de l’entrée de bureau. Résultat : code 0, `Desktop window and isolated preload loaded.`, `Repository read through preload IPC: {"branch":"main","files":1,"commits":1,"subject":"installer smoke"}`, `Purged cleanly`.
- Isolation : aucun paquet installé sur l’hôte (`dpkg -s git-workbench` absent, pas de `/opt/Git Workbench`). Le conteneur lève les profils seccomp/AppArmor par défaut de Docker, qui interdisent les espaces de noms utilisateur autorisés par un Debian 13 standard.
- Limites : seul Debian 13 x86_64 (conteneur, affichage virtuel) est vérifié ; pas de parcours UI manuel. Le repli SUID de `chrome-sandbox` (systèmes sans espaces de noms utilisateur) échoue dans un conteneur Docker sans privilèges et n’est pas vérifié. Paquet non signé, publié sur aucun dépôt APT ; aucune autre distribution, architecture ni OS n’est annoncé.

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
