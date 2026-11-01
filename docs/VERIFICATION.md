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

- `npm test` : 18/18 tests passés (commande exécutée le 2026-10-31) ; au 2026-10-31 après MON-643 : 25/25 (19 tests d’intégration Git + 3 tests de packaging + 3 tests de l’éditeur de séquence).
- `npm run lint` et `npm run typecheck` via l’entrée npm directe : les deux scripts déclarés passent ; lint vérifie 8 fichiers JavaScript et typecheck les invariants du projet (`private: true`, `license: UNLICENSED`).
- `npm run build` : Vite 7.3.7 et electron-builder 26.18.0 ont produit `artifacts/linux-unpacked` pour Linux x64 avec Electron 39.8.10.
- Smoke de la fenêtre empaquetée : `xvfb-run -a env GIT_WORKBENCH_SMOKE=1 ELECTRON_DISABLE_GPU=1 artifacts/linux-unpacked/git-workbench --no-sandbox --disable-gpu` — code 0.
- Limite de cet essai : pas de parcours manuel interactif de chaque contrôle UI ni de test de plateforme hors Debian 13 x86_64. Windows 10+ x64, macOS 12+ Intel/Apple Silicon, Ubuntu 22.04 x86_64 et Debian 12 x86_64 ne sont pas testés et ne sont pas déclarés supportés.

Le wrapper terminal a d’abord mal parsé la sortie de lint (`ESLint output (JSON parse failed: EOF while parsing a value at line 1 column 0)`, code 1) ; le contrôle a été repris par l’entrée npm directe, avec succès. Il s’agit de vérifications locales, pas d’une exécution GitHub Actions. La build candidate actuelle est un répertoire Linux x64 unpacked (284 MiB) dans `artifacts/linux-unpacked`; le smoke test empaqueté sous `xvfb-run` retourne `Desktop window and isolated preload loaded.` (code 0). Aucun artefact Windows/macOS n’a été produit sur cet hôte Linux.

## Installateur Linux x64 (`.deb`) — MON-643

Format retenu : paquet Debian x64 (voir `docs/adr/0002-linux-installer.md`). Vérifié le 2026-10-31 :

- Build : `npm run package:linux -- -c.extraMetadata.version=1.0.0-rc.1+bf78eee` depuis le commit `bf78eee` (= `v1.0.0-rc.1` + packaging, smoke installateur et correctif du rebase interactif empaqueté) ; electron-builder 26.18.0, fpm 1.17.0 (outil téléchargé par electron-builder), Electron 39.8.10. Sortie : `git-workbench_1.0.0-rc.1+bf78eee_amd64.deb`, 90 864 296 octets, version Debian `1.0.0~rc.1+bf78eee`, arch `amd64`, dépendance `git` déclarée.
- SHA-256 : `ee4eba9d55f173b10e08db9d4af3388970318f360bea29b3b20491a760395d0c`.
- Smoke : `sh scripts/smoke-linux-installer.sh <deb>` — conteneur jetable `debian:trixie` (`sha256:2dc419c6d7fe3dad0a2f9fd469c34cc90b0f9ba642d8fde837fe3d7d34a0e7f1`), Docker 26.1.5, x86_64. Le script vérifie la somme, installe via `apt-get install ./…deb` (résolution des dépendances), contrôle `dpkg -s`, le lanceur `/usr/bin/git-workbench` et l’entrée `git-workbench.desktop`, lance l’application installée sous `xvfb-run` en utilisateur non root avec le sandbox Chromium actif (`chrome-sandbox` 755, espaces de noms utilisateur ; jamais `--no-sandbox`), lit un dépôt Git jetable via le pont preload → IPC → Git CLI, exécute dans l’app installée un rebase interactif (pick/drop) sur ce dépôt jetable, puis `apt-get purge` et contrôle l’absence de `/opt/Git Workbench`, du lanceur et de l’entrée de bureau. Résultat : code 0, `Desktop window and isolated preload loaded.`, `Repository read through preload IPC: {"branch":"main","files":0,"commits":3,"subject":"installer smoke"}`, `Packaged interactive rebase applied: installer smoke < base`, `Purged cleanly`.
- Défaut trouvé et corrigé par ce smoke : dans une build empaquetée, `process.execPath` est le binaire de l’app ; l’éditeur de séquence du rebase interactif ouvrait donc une seconde instance au lieu d’appliquer le plan (`git-operation-failed`, historique inchangé). Les tests `node --test` ne le voyaient pas (exécutés sous Node). Correctif `bf78eee` : préfixe `ELECTRON_RUN_AS_NODE=1` limité à la commande éditeur (jamais hérité par les hooks). La candidate `0c44b6de…` construite avant ce correctif est remplacée.
- Isolation : aucun paquet installé sur l’hôte (`dpkg -s git-workbench` absent, pas de `/opt/Git Workbench`). Le conteneur lève les profils seccomp/AppArmor par défaut de Docker, qui interdisent les espaces de noms utilisateur autorisés par un Debian 13 standard.
- Limites : seul Debian 13 x86_64 (conteneur, affichage virtuel) est vérifié ; pas de parcours UI manuel (boîtes de confirmation natives non exercées par le smoke). Le repli SUID de `chrome-sandbox` (systèmes sans espaces de noms utilisateur) échoue dans un conteneur Docker sans privilèges et n’est pas vérifié. Paquet non signé, publié sur aucun dépôt APT ; aucune autre distribution, architecture ni OS n’est annoncé.

## Installateur Windows x64 (NSIS) — MON-647

Format retenu : installateur NSIS par utilisateur, x64 (voir `docs/adr/0003-windows-installer.md`). Vérifié le 2026-10-31 :

- Build : `sh scripts/package-windows-release.sh` depuis le commit `45f924f`, dans le conteneur public `electronuserland/builder:wine` (Ubuntu 22.04, Wine 11.0, Docker 26.1.5) — nécessaire car electron-builder ne peut invoquer NSIS sans wine sur cet hôte (`spawn wine ENOENT`). electron-builder 26.18.0, Electron 39.8.10. Sortie : `Git Workbench Setup 1.0.0-rc.1+45f924f.exe`, 102 016 516 octets (97.3 Mio), arch x64, `perMachine: false` (installation sans droits admin).
- SHA-256 : `70a18810e7a7d755ba9996585fdd84c497a3c51a74bd5bce114fda9a40d9f113`.
- Contrôles statiques (`sh scripts/smoke-win-installer.sh`) : somme SHA-256 recalculée et concordante, en-tête PE (`MZ`) valide, taille plausible (>10 Mo).
- Assistant d'installation observé visuellement (captures d'écran prises via Xvfb + xdotool dans le même conteneur) : titre et version corrects (« Git Workbench 1.0.0-rc.1+45f924f »), écran « Choose Installation Options » avec **« Only for me (root) »** pré-sélectionné et chemin par défaut sous `AppData\Local\Programs\Git Workbench` — confirme une installation par utilisateur, sans admin, conforme à la décision.
- **Non vérifié ici : installation/lancement/désinstallation automatisés.** Une tentative d'installation silencieuse (`wine setup.exe /S`) échoue systématiquement (code 2). Cause identifiée par capture d'écran en mode non silencieux : le contrôle mono-instance NSIS d'electron-builder (nommé-pipe/RPC) détecte à tort une instance déjà lancée (« Git Workbench is running » puis boucle « Retry » qui ne se résout jamais), à cause du support RPC/DCOM incomplet de Wine (`err:ole:StdMarshalImpl_MarshalInterface`, `Failed to open RpcSs service`). C'est une incompatibilité connue entre les installateurs NSIS d'electron-builder et Wine, indépendante de l'application. Aucune plateforme Windows n'est donc déclarée vérifiée de bout en bout par ce run.
- Décision d'Antoine (carte MON-647, 2026-10-31) : il effectue lui-même la vérification réelle (installation, lancement, rebase interactif, désinstallation) sur son poste Windows 11 x64, faute de ressources internes pour une QA manuelle complète ; l'artefact lui est remis via une pré-release GitHub officielle (dépôt privé, tag `-rc.N`). Procédure détaillée : `docs/WINDOWS-INSTALL-CHECK.md`. Tant que ce retour n'est pas rapporté sur l'issue, aucune installation Windows réelle n'est revendiquée comme vérifiée.
- Signature : non signée pour cette tranche (décision « sign_later »). Coût de signature (OV/EV, non engagé) documenté dans `docs/adr/0003-windows-installer.md`.
- Limites : seul le build dans ce conteneur Ubuntu 22.04 + Wine 11.0 est vérifié ; aucune autre méthode de build Windows n'est annoncée. macOS et ARM64 restent hors périmètre (Antoine a confirmé un poste Intel/AMD x64).

### Incident CI réel constaté et corrigé (merge vers `rc`, 2026-10-31)

La revue indépendante (MON-662) avait exécuté `npm run build` (sans le conteneur Wine) et validé la CI de la PR (job `quality`, qui ne construit pas l'installateur Windows). Au premier push réel sur `rc` après le merge de la PR #3 (commit `03e2b8c2`), le job `release` (`semantic-release` → `prepareCmd` → `scripts/package-windows-release.sh`) a échoué : `tee: 'artifacts/Git Workbench Setup …exe.sha256': Permission denied`. Cause : l'image `electronuserland/builder:wine` tourne en `root` ; les fichiers qu'elle écrit dans `artifacts/` (volume monté) restent root-owned sur l'hôte, alors que l'étape `sha256sum … | tee …` qui suit s'exécute hors conteneur en utilisateur normal (le runner GitHub Actions). L'étape de build NSIS elle-même avait réussi (`.exe` produit et son SHA-256 affiché dans les logs électron-builder) ; seule l'écriture du fichier `.exe.sha256` par le script échouait.

Correctif (`scripts/package-windows-release.sh`) : `chown -R <uid hôte>:<gid hôte> artifacts` exécuté à l'intérieur du conteneur (encore root) juste après `npm run package:win`, avant sa sortie — rend l'hôte à nouveau propriétaire de `artifacts/` pour l'étape `tee` suivante. Reproduit et vérifié en local avant commit : build complet rejoué avec le script corrigé, `artifacts/*.exe` et `*.exe.sha256` possédés par l'utilisateur courant (plus `root`), `sha256sum -c` confirme `OK`. Correctif livré par PR dédiée vers `rc`, avec le même exigence de revue indépendante (Miki) avant fusion ; voir l'historique Git pour le commit et le run CI qui a validé le second push.

## Sécurité et confidentialité — limites explicites

- Le processus Git est lancé par `spawn('git', args, { shell: false })` ; les chemins de fichiers sont passés après `--`. Electron utilise `contextIsolation`, `sandbox`, `webSecurity`, `nodeIntegration: false`, navigation externe bloquée et CSP `connect-src 'none'`.
- Le code de l’application ne comporte pas de compte, télémétrie, API hébergée ni appel réseau applicatif. L’inspection, les diffs, stage/unstage et commits sont locaux. Les secrets ne sont pas écrits dans les journaux d’application.
- Un push est une exception volontaire et explicite : après confirmation, Git transmet les commits à l’upstream affiché. Git/SSH/credential helper configuré par l’utilisateur gère l’authentification ; l’app ne stocke ni n’affiche le token. Le push vérifie ensuite le hash de la branche distante via `git ls-remote`.
- Les hooks et credential helpers configurés restent actifs. Les hooks sont des programmes choisis par l’utilisateur et peuvent avoir leurs propres effets réseau ; ceux-ci ne sont pas sandboxés/garantis par Git Workbench. Aucune capture réseau avec proxy n’a été réalisée : la garantie ci-dessus repose sur l’inspection de la configuration et du code ainsi que sur les tests locaux, pas sur une observation exhaustive de toutes les extensions/hooks de l’utilisateur.
- Pas de force-push ; refus d’upstream modifié, de remote rejetant et remote indisponible. Le push indéterminé est signalé comme tel.

## Hors MVP / limites

- Stage/unstage partiel (bloc, ligne) : `git apply --cached` puis relecture de `git diff --cached` et du contenu indexé, restauration de l’index en cas d’écart (`test/partial-staging.test.js`). Refusé pour les fichiers renommés, en conflit, binaires, liens symboliques, à filtre Git autre que les fins de ligne, ou à fins de ligne CR seules : ceux-là s’indexent en entier. Le chemin « vérification échouée → index restauré » n’est pas reproduit par un test (aucune fixture ne fait diverger `git apply`) ; le refus de `git apply` (index verrouillé) l’est.
- Rebase interactif : actions `pick`, `drop`, `fixup` uniquement ; pas de reword/edit/squash.
- Pas de merge, fetch/pull automatique, résolution intégrée de conflits, force-push, opérations reset/discard/amend/squash, intégrations d’hébergeur, comptes, télémétrie ni distribution publique.
- Une référence `refs/git-workbench/recovery/...` est conservée avant cherry-pick/rebase. Après conflit, le dépôt reste dans l’état Git d’opération interrompue ; terminer avec Git ou utiliser la commande `--abort` indiquée dans le message.
