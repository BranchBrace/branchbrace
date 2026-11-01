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
