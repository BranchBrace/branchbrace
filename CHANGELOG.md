# [1.2.0-rc.2](https://github.com/BranchBrace/branchbrace/compare/v1.2.0-rc.1...v1.2.0-rc.2) (2026-11-03)


### Features

* **release:** publier le paquet .deb Linux x64 avec chaque release ([ef0f554](https://github.com/BranchBrace/branchbrace/commit/ef0f554d18c6f85ed30ae77e0df703afc97b4d0e))

# [1.2.0-rc.1](https://github.com/BranchBrace/branchbrace/compare/v1.1.0...v1.2.0-rc.1) (2026-11-03)


### Bug Fixes

* **dev:** charger vscode-textmate et vscode-oniguruma sous Vite en développement ([6eefdbd](https://github.com/BranchBrace/branchbrace/commit/6eefdbd1c5fef7492ea32798b2ff99a7e4263933))
* **securite:** corriger les vulnérabilités high/critical des dépendances ([0af341e](https://github.com/BranchBrace/branchbrace/commit/0af341e7f357caeb737f7dd9207e81ea4f882be9))


### Features

* **windows:** publier une version portable sans installateur ([46ff4bc](https://github.com/BranchBrace/branchbrace/commit/46ff4bc4436a363c4d142cced24cd4744ae50e44))

# [1.1.0](https://github.com/BranchBrace/branchbrace/compare/v1.0.0...v1.1.0) (2026-11-01)


### Bug Fixes

* **ci:** épingler le job release sur ubuntu-24.04 ([6986b52](https://github.com/BranchBrace/branchbrace/commit/6986b52803f3adb47338a8b2a1edd7a3fc195cd8))
* **diff:** afficher les CodeLens « Indexer ce bloc » dans l'éditeur de diff ([3fa6e1d](https://github.com/BranchBrace/branchbrace/commit/3fa6e1d0168e80f44173341e2e3172cccaa7255a))
* **diff:** ne pas associer de fichiers à une grammaire d'une autre provenance ([8baa016](https://github.com/BranchBrace/branchbrace/commit/8baa016e18316b5bf75cc25e4fb8f45f788505e7))
* **diff:** retomber sur Monarch quand une grammaire TextMate échoue ([4137d7b](https://github.com/BranchBrace/branchbrace/commit/4137d7b8e6e55c0c7464e0b7fd43ac638dbb3222))
* **extensions:** garder l'ancienne version si l'import d'un .vsix échoue ([40365ec](https://github.com/BranchBrace/branchbrace/commit/40365ecdd6d9b217cff56f0228d42b0f10d8e748))
* **ipc:** refermer le gestionnaire du découpage de commit ([c2aaf64](https://github.com/BranchBrace/branchbrace/commit/c2aaf642d81ceefd8a0e5c86abad81b2ebf2fde7))
* **packaging:** embarquer sync-settings.js et favicon.js dans l'asar ([894c96f](https://github.com/BranchBrace/branchbrace/commit/894c96f37efe1840a62ca81faf7aa607d8a1ffb6))
* **sync:** fetch d'arrière-plan sans invite et verrou partagé avec le pull ([b54f22f](https://github.com/BranchBrace/branchbrace/commit/b54f22f15d16ce137cfc897ecfb3a2a84c1b248d))
* **ui:** écarter les résultats de fetch et de pull périmés ([3b31752](https://github.com/BranchBrace/branchbrace/commit/3b317529b71140b9067261d112295a03d3f0dbf3))
* **updates:** ne plus écraser la méthode ui.update avec la mise à jour trouvée ([74df5ab](https://github.com/BranchBrace/branchbrace/commit/74df5ab9101337d2de1d4b9634ac7498c0fe437d))
* **updates:** suivre le dépôt transféré vers BranchBrace/branchbrace ([c318c5a](https://github.com/BranchBrace/branchbrace/commit/c318c5a20066f082c3021ddb2c5d68cd31aa3760))
* **worktrees:** fiabiliser renommage distant et gestion des worktrees ([7838dbe](https://github.com/BranchBrace/branchbrace/commit/7838dbed641e4c421d83c6a55d7fe7454639f094))


### Features

* **branches:** renommer une branche locale, et en option sa distante ([7cef227](https://github.com/BranchBrace/branchbrace/commit/7cef22712cb8a9f7f260f18ee3d29ba5b3d445e1))
* **diff:** actions d'indexation par bloc et par ligne dans la vue de diff ([942ba36](https://github.com/BranchBrace/branchbrace/commit/942ba36ed0aad846e6e395476e443a3b490f0be2))
* **diff:** coloration par les grammaires TextMate des extensions VS Code ([b8dbc88](https://github.com/BranchBrace/branchbrace/commit/b8dbc88e6a788e43db00be193d71727ad417550c))
* gérer les remotes et le push forcé avec lease ([76a6bf4](https://github.com/BranchBrace/branchbrace/commit/76a6bf4a7b58e7a636cf75639032ab0a078e5a18))
* **git:** revert, renommage de branche et tags depuis le graphe ([7fe8d86](https://github.com/BranchBrace/branchbrace/commit/7fe8d862347fbc1b003ce771b412ae39dd99553e))
* merge local et pull en fast-forward seul ([983f8f1](https://github.com/BranchBrace/branchbrace/commit/983f8f11abd3f9839b4bf56bf2f23881f0ba3b69))
* renommer le projet en BranchBrace et ajouter Buy Me a Coffee ([0a6d9b0](https://github.com/BranchBrace/branchbrace/commit/0a6d9b0cb06d437a0a25fece07eaab9e473b7eb7))
* **reprise:** point de reprise étendu et Undo/Redo locaux (A17) ([a3f8c96](https://github.com/BranchBrace/branchbrace/commit/a3f8c963410e6e6002c75c233960c3ad41d71fa7))
* **staging:** indexation par bloc et découpage d'un commit ([d32a5c1](https://github.com/BranchBrace/branchbrace/commit/d32a5c197721bcef38d2e84d0660ea40b5a40173))
* **staging:** indexer et désindexer par bloc et par ligne avec garde de fiabilité ([bb4f42f](https://github.com/BranchBrace/branchbrace/commit/bb4f42f425d6e83d5daf604f768da962334cdaab))
* **sync:** fetch automatique en arrière-plan et pull en avance rapide ([c87fee8](https://github.com/BranchBrace/branchbrace/commit/c87fee81d72a25adae0e893bff24ab5a2bde2ceb))
* **ui:** liste de fichiers compacte et défilement conservé ([8c801d6](https://github.com/BranchBrace/branchbrace/commit/8c801d658b42d113f9133cd27e176483b54d6cc4))
* **ui:** logo de l'hébergeur à côté de chaque dépôt distant ([15a5bb6](https://github.com/BranchBrace/branchbrace/commit/15a5bb6dc0574d3496eaac673206669e953472ed))
* **updates:** mises à jour depuis les releases GitHub, canal stable ou bêta ([efd1518](https://github.com/BranchBrace/branchbrace/commit/efd15180b27ba146edd74adf5473e0e18fb6802a))
* **worktrees:** lister, créer, ouvrir et supprimer les worktrees ([b869a80](https://github.com/BranchBrace/branchbrace/commit/b869a80f7a70158f76c60784283582e69556565f))

# [1.1.0-rc.9](https://github.com/BranchBrace/branchbrace/compare/v1.1.0-rc.8...v1.1.0-rc.9) (2026-11-01)


### Bug Fixes

* **ci:** épingler le job release sur ubuntu-24.04 ([6986b52](https://github.com/BranchBrace/branchbrace/commit/6986b52803f3adb47338a8b2a1edd7a3fc195cd8))
* **packaging:** embarquer sync-settings.js et favicon.js dans l'asar ([894c96f](https://github.com/BranchBrace/branchbrace/commit/894c96f37efe1840a62ca81faf7aa607d8a1ffb6))
* **updates:** suivre le dépôt transféré vers BranchBrace/branchbrace ([c318c5a](https://github.com/BranchBrace/branchbrace/commit/c318c5a20066f082c3021ddb2c5d68cd31aa3760))

# [1.1.0-rc.8](https://github.com/monnierant/git-workbench/compare/v1.1.0-rc.7...v1.1.0-rc.8) (2026-11-01)


### Features

* renommer le projet en BranchBrace et ajouter Buy Me a Coffee ([0a6d9b0](https://github.com/monnierant/git-workbench/commit/0a6d9b0cb06d437a0a25fece07eaab9e473b7eb7))

# [1.1.0-rc.7](https://github.com/monnierant/git-workbench/compare/v1.1.0-rc.6...v1.1.0-rc.7) (2026-11-01)


### Features

* **reprise:** point de reprise étendu et Undo/Redo locaux (A17) ([a3f8c96](https://github.com/monnierant/git-workbench/commit/a3f8c963410e6e6002c75c233960c3ad41d71fa7))

# [1.1.0-rc.6](https://github.com/monnierant/git-workbench/compare/v1.1.0-rc.5...v1.1.0-rc.6) (2026-11-01)


### Bug Fixes

* **diff:** afficher les CodeLens « Indexer ce bloc » dans l'éditeur de diff ([3fa6e1d](https://github.com/monnierant/git-workbench/commit/3fa6e1d0168e80f44173341e2e3172cccaa7255a))
* **ipc:** refermer le gestionnaire du découpage de commit ([c2aaf64](https://github.com/monnierant/git-workbench/commit/c2aaf642d81ceefd8a0e5c86abad81b2ebf2fde7))


### Features

* **staging:** indexation par bloc et découpage d'un commit ([d32a5c1](https://github.com/monnierant/git-workbench/commit/d32a5c197721bcef38d2e84d0660ea40b5a40173))

# [1.1.0-rc.5](https://github.com/monnierant/git-workbench/compare/v1.1.0-rc.4...v1.1.0-rc.5) (2026-11-01)


### Features

* gérer les remotes et le push forcé avec lease ([76a6bf4](https://github.com/monnierant/git-workbench/commit/76a6bf4a7b58e7a636cf75639032ab0a078e5a18))
* **git:** revert, renommage de branche et tags depuis le graphe ([7fe8d86](https://github.com/monnierant/git-workbench/commit/7fe8d862347fbc1b003ce771b412ae39dd99553e))

# [1.1.0-rc.4](https://github.com/monnierant/git-workbench/compare/v1.1.0-rc.3...v1.1.0-rc.4) (2026-11-01)


### Bug Fixes

* **diff:** ne pas associer de fichiers à une grammaire d'une autre provenance ([8baa016](https://github.com/monnierant/git-workbench/commit/8baa016e18316b5bf75cc25e4fb8f45f788505e7))
* **diff:** retomber sur Monarch quand une grammaire TextMate échoue ([4137d7b](https://github.com/monnierant/git-workbench/commit/4137d7b8e6e55c0c7464e0b7fd43ac638dbb3222))
* **extensions:** garder l'ancienne version si l'import d'un .vsix échoue ([40365ec](https://github.com/monnierant/git-workbench/commit/40365ecdd6d9b217cff56f0228d42b0f10d8e748))
* **sync:** fetch d'arrière-plan sans invite et verrou partagé avec le pull ([b54f22f](https://github.com/monnierant/git-workbench/commit/b54f22f15d16ce137cfc897ecfb3a2a84c1b248d))
* **ui:** écarter les résultats de fetch et de pull périmés ([3b31752](https://github.com/monnierant/git-workbench/commit/3b317529b71140b9067261d112295a03d3f0dbf3))
* **updates:** ne plus écraser la méthode ui.update avec la mise à jour trouvée ([74df5ab](https://github.com/monnierant/git-workbench/commit/74df5ab9101337d2de1d4b9634ac7498c0fe437d))


### Features

* **diff:** actions d'indexation par bloc et par ligne dans la vue de diff ([942ba36](https://github.com/monnierant/git-workbench/commit/942ba36ed0aad846e6e395476e443a3b490f0be2))
* **diff:** coloration par les grammaires TextMate des extensions VS Code ([b8dbc88](https://github.com/monnierant/git-workbench/commit/b8dbc88e6a788e43db00be193d71727ad417550c))
* **staging:** indexer et désindexer par bloc et par ligne avec garde de fiabilité ([bb4f42f](https://github.com/monnierant/git-workbench/commit/bb4f42f425d6e83d5daf604f768da962334cdaab))
* **sync:** fetch automatique en arrière-plan et pull en avance rapide ([c87fee8](https://github.com/monnierant/git-workbench/commit/c87fee81d72a25adae0e893bff24ab5a2bde2ceb))

# [1.1.0-rc.3](https://github.com/monnierant/git-workbench/compare/v1.1.0-rc.2...v1.1.0-rc.3) (2026-11-01)


### Bug Fixes

* **worktrees:** fiabiliser renommage distant et gestion des worktrees ([7838dbe](https://github.com/monnierant/git-workbench/commit/7838dbed641e4c421d83c6a55d7fe7454639f094))


### Features

* **branches:** renommer une branche locale, et en option sa distante ([7cef227](https://github.com/monnierant/git-workbench/commit/7cef22712cb8a9f7f260f18ee3d29ba5b3d445e1))
* **worktrees:** lister, créer, ouvrir et supprimer les worktrees ([b869a80](https://github.com/monnierant/git-workbench/commit/b869a80f7a70158f76c60784283582e69556565f))

# [1.1.0-rc.2](https://github.com/monnierant/git-workbench/compare/v1.1.0-rc.1...v1.1.0-rc.2) (2026-11-01)


### Features

* merge local et pull en fast-forward seul ([983f8f1](https://github.com/monnierant/git-workbench/commit/983f8f11abd3f9839b4bf56bf2f23881f0ba3b69))

# [1.1.0-rc.1](https://github.com/monnierant/git-workbench/compare/v1.0.0...v1.1.0-rc.1) (2026-11-01)


### Features

* **ui:** liste de fichiers compacte et défilement conservé ([8c801d6](https://github.com/monnierant/git-workbench/commit/8c801d658b42d113f9133cd27e176483b54d6cc4))
* **ui:** logo de l'hébergeur à côté de chaque dépôt distant ([15a5bb6](https://github.com/monnierant/git-workbench/commit/15a5bb6dc0574d3496eaac673206669e953472ed))
* **updates:** mises à jour depuis les releases GitHub, canal stable ou bêta ([efd1518](https://github.com/monnierant/git-workbench/commit/efd15180b27ba146edd74adf5473e0e18fb6802a))

# 1.0.0 (2026-10-31)


### Bug Fixes

* build renderer before asset smoke test ([321064a](https://github.com/MonniHermes/git-workbench/commit/321064a9de9df3be16e270f9ed4121f98e3759b0))
* chown Windows build artifacts to host user before hashing ([00c90dc](https://github.com/MonniHermes/git-workbench/commit/00c90dcaa31561897493e579f46dd3007f53c132)), closes [#3](https://github.com/MonniHermes/git-workbench/issues/3)
* close git env hijack and add informed confirmation previews ([72f29bc](https://github.com/MonniHermes/git-workbench/commit/72f29bc07d0203976e9140077522bd29a57fd487))
* load renderer assets in packaged Windows build ([66ef11f](https://github.com/MonniHermes/git-workbench/commit/66ef11fcc74809172b5ea7f0b84b6838c6db6088))
* **rebase:** accepter un squash qui suit un commit écarté ([26c7106](https://github.com/MonniHermes/git-workbench/commit/26c7106bb19fff411bdfd4797af5655b73a61c7a))
* run the interactive rebase plan editor as Node in packaged builds ([bf78eee](https://github.com/MonniHermes/git-workbench/commit/bf78eeeb9293a11a01a56d7605ee90b458f61ecb))
* **ui:** ne confirmer que le push et les rebases ([f0dcf35](https://github.com/MonniHermes/git-workbench/commit/f0dcf3563344513801d58c3ea3b4439ce9cff9eb))


### Features

* build desktop MVP workflow ([c6e4a7c](https://github.com/MonniHermes/git-workbench/commit/c6e4a7c6d00c8ef5e9896cfe9d55691ec203e1be))
* package Linux x64 MVP as a verified Debian installer ([477a50e](https://github.com/MonniHermes/git-workbench/commit/477a50e5575d690563458f834b847a390b19a104))
* package Windows x64 MVP as a verified NSIS installer ([096b8a2](https://github.com/MonniHermes/git-workbench/commit/096b8a2fef9679f637318e86e4cc0126d6c4e42e))
* **ui:** éditeur Monaco, résolution de conflits, amend et rebase interactif refondu ([75f6632](https://github.com/MonniHermes/git-workbench/commit/75f66325c4f897ee8956a03983be3a2eccf3aa5b))
* **ui:** rebase interactif plein écran, revue de commit et repères local/distant ([319c8f5](https://github.com/MonniHermes/git-workbench/commit/319c8f5294ba0be22e23f84b20a132288c0587f9))
* **ui:** refonte de l'interface façon GitKraken, retrait du module Rust et refus visibles des commandes ([025291e](https://github.com/MonniHermes/git-workbench/commit/025291e78c5a35beead364689560dba7c3fb76f8))
* **ui:** revue et correction des résolutions de conflit ([077aab9](https://github.com/MonniHermes/git-workbench/commit/077aab9b200b9fd4b2c1f8483131693038208874))
* **windows:** sign and verify the installer in the Wine build when signing is configured ([f8a7c27](https://github.com/MonniHermes/git-workbench/commit/f8a7c27dd9113fbf40e567b892176204992449be))
* **windows:** sign every Windows binary through a jsign electron-builder hook ([53a9b4e](https://github.com/MonniHermes/git-workbench/commit/53a9b4ee629bcf2f5702baf8504ccc5c6246e573))

# [1.0.0-rc.6](https://github.com/MonniHermes/git-workbench/compare/v1.0.0-rc.5...v1.0.0-rc.6) (2026-10-31)


### Bug Fixes

* **rebase:** accepter un squash qui suit un commit écarté ([26c7106](https://github.com/MonniHermes/git-workbench/commit/26c7106bb19fff411bdfd4797af5655b73a61c7a))


### Features

* **ui:** éditeur Monaco, résolution de conflits, amend et rebase interactif refondu ([75f6632](https://github.com/MonniHermes/git-workbench/commit/75f66325c4f897ee8956a03983be3a2eccf3aa5b))
* **ui:** rebase interactif plein écran, revue de commit et repères local/distant ([319c8f5](https://github.com/MonniHermes/git-workbench/commit/319c8f5294ba0be22e23f84b20a132288c0587f9))
* **ui:** revue et correction des résolutions de conflit ([077aab9](https://github.com/MonniHermes/git-workbench/commit/077aab9b200b9fd4b2c1f8483131693038208874))

# [1.0.0-rc.5](https://github.com/MonniHermes/git-workbench/compare/v1.0.0-rc.4...v1.0.0-rc.5) (2026-10-31)


### Bug Fixes

* **ui:** ne confirmer que le push et les rebases ([f0dcf35](https://github.com/MonniHermes/git-workbench/commit/f0dcf3563344513801d58c3ea3b4439ce9cff9eb))


### Features

* **ui:** refonte de l'interface façon GitKraken, retrait du module Rust et refus visibles des commandes ([025291e](https://github.com/MonniHermes/git-workbench/commit/025291e78c5a35beead364689560dba7c3fb76f8))

# [1.0.0-rc.4](https://github.com/MonniHermes/git-workbench/compare/v1.0.0-rc.3...v1.0.0-rc.4) (2026-10-31)


### Features

* **windows:** sign and verify the installer in the Wine build when signing is configured ([f8a7c27](https://github.com/MonniHermes/git-workbench/commit/f8a7c27dd9113fbf40e567b892176204992449be))
* **windows:** sign every Windows binary through a jsign electron-builder hook ([53a9b4e](https://github.com/MonniHermes/git-workbench/commit/53a9b4ee629bcf2f5702baf8504ccc5c6246e573))

# [1.0.0-rc.3](https://github.com/MonniHermes/git-workbench/compare/v1.0.0-rc.2...v1.0.0-rc.3) (2026-10-31)


### Bug Fixes

* build renderer before asset smoke test ([321064a](https://github.com/MonniHermes/git-workbench/commit/321064a9de9df3be16e270f9ed4121f98e3759b0))
* load renderer assets in packaged Windows build ([66ef11f](https://github.com/MonniHermes/git-workbench/commit/66ef11fcc74809172b5ea7f0b84b6838c6db6088))

# [1.0.0-rc.2](https://github.com/MonniHermes/git-workbench/compare/v1.0.0-rc.1...v1.0.0-rc.2) (2026-10-31)


### Bug Fixes

* chown Windows build artifacts to host user before hashing ([00c90dc](https://github.com/MonniHermes/git-workbench/commit/00c90dcaa31561897493e579f46dd3007f53c132)), closes [#3](https://github.com/MonniHermes/git-workbench/issues/3)
* run the interactive rebase plan editor as Node in packaged builds ([bf78eee](https://github.com/MonniHermes/git-workbench/commit/bf78eeeb9293a11a01a56d7605ee90b458f61ecb))


### Features

* package Linux x64 MVP as a verified Debian installer ([477a50e](https://github.com/MonniHermes/git-workbench/commit/477a50e5575d690563458f834b847a390b19a104))
* package Windows x64 MVP as a verified NSIS installer ([096b8a2](https://github.com/MonniHermes/git-workbench/commit/096b8a2fef9679f637318e86e4cc0126d6c4e42e))

# 1.0.0-rc.1 (2026-10-30)


### Bug Fixes

* close git env hijack and add informed confirmation previews ([72f29bc](https://github.com/MonniHermes/git-workbench/commit/72f29bc07d0203976e9140077522bd29a57fd487))


### Features

* build desktop MVP workflow ([c6e4a7c](https://github.com/MonniHermes/git-workbench/commit/c6e4a7c6d00c8ef5e9896cfe9d55691ec203e1be))
