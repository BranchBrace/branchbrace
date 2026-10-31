# ADR 0003 — Installateur Windows x64 du MVP

- Statut : accepté techniquement pour cette tranche
- Date : 2026-10-31
- Décideur : Takumi · Lead Dev général
- Contexte : [MON-647](/MON/issues/MON-647), sous [MON-629](/MON/issues/MON-629) ; réutilise la branche de [PR #3](https://github.com/MonniHermes/git-workbench/pull/3) (correctif rebase packagé de MON-645).
- Décisions d'Antoine (carte MON-647, répondue le 2026-10-31) : vérification = lui-même sur son poste (nous ne faisons pas de QA manuelle faute de ressources) ; remise = publication officielle d'une RC sur le dépôt ; signature = différée, avec un coût préparé pour décision ultérieure ; poste cible = Windows 11 x64 (Intel/AMD), pas d'ARM64.

## Décision

Livrer le MVP Windows x64 sous forme d'installateur NSIS par utilisateur (`win.target=nsis`, arch `x64`), produit par `npm run package:win`, sans droits admin (`perMachine: false`), désinstallable depuis Paramètres > Applications, avec suppression des données applicatives à la désinstallation (`deleteAppDataOnUninstall: true`, parité avec le `apt purge` Linux).

Build : image Docker publique et gratuite `electronuserland/builder:wine` (contient Wine, nécessaire car NSIS appelle un binaire Windows — `spawn wine ENOENT` sans elle). Aucun coût, aucun nouveau service externe.

Remise : via la pipeline de release existante (`semantic-release` sur push `rc`/`main`). `.releaserc.json` ajoute un `prepareCmd` (`scripts/package-windows-release.sh ${nextRelease.version}`) qui construit l'installateur avec la version de la release, et configure `@semantic-release/github` pour l'attacher en asset de la GitHub Release (`.exe` + `.exe.sha256`). Le dépôt `MonniHermes/git-workbench` est **privé** : la Release reste visible des seuls collaborateurs, ce n'est pas un lancement public. Le statut prerelease (RC) de la branche `rc` signale explicitement que l'artefact n'est pas destiné à un usage final.

Signature : non signée pour cette tranche (décision « sign_later » d'Antoine). Coût préparé ci-dessous pour une décision ultérieure, aucune dépense engagée.

## Vérification réalisée et ses limites

### Build (vérifié)
`npm run package:win` dans le conteneur Docker ci-dessus produit un installateur NSIS x64 valide :
- `Git Workbench Setup 1.0.0-rc.1+45f924f.exe`, 97.3 Mo, en-tête PE (`MZ`) valide.
- SHA-256 calculé et conservé à côté de l'artefact.
- Assistant d'installation vérifié visuellement (captures d'écran) : titre et version corrects (« Git Workbench 1.0.0-rc.1+45f924f »), écran de choix d'installation affichant bien **« Only for me (root) »** pré-sélectionné (confirme l'installation par utilisateur, sans admin) et un chemin sous `AppData\Local\Programs`.

### Smoke silencieux automatisé : NON concluant sous Wine (limite documentée)
Une tentative d'installation silencieuse (`wine setup.exe /S`) à des fins de smoke automatisé échoue systématiquement (code retour 2). Diagnostic confirmé par capture d'écran en mode non silencieux : le vérificateur mono-instance NSIS d'electron-builder (pipe nommé / vérification RPC) détecte à tort « Git Workbench is running » et reste bloqué sur une boucle « Retry » qui ne se résout jamais — cause : le support RPC/DCOM de Wine est incomplet (`err:ole:StdMarshalImpl_MarshalInterface`, `Failed to open RpcSs service`). C'est une incompatibilité connue entre les installateurs NSIS générés par electron-builder et Wine, indépendante de notre application.

**Conséquence : aucune installation/lancement/désinstallation automatisés n'est revendiquée sous Windows.** `scripts/smoke-win-installer.sh` se limite donc à des contrôles statiques exécutables sans Windows (somme SHA-256, en-tête PE, taille plausible) — pas un substitut au smoke réel.

### Smoke réel : délégué à Antoine (décision explicite)
Antoine a choisi de valider lui-même sur son poste Windows 11 x64, faute de ressources internes pour une QA manuelle complète. Les étapes précises à suivre sont dans `docs/WINDOWS-INSTALL-CHECK.md`. Tant qu'il n'a pas rapporté ce résultat, **aucune installation Windows réelle n'est revendiquée comme vérifiée.**

## Motif et alternatives

- Runner Windows natif (GitHub Actions `windows-latest`) : non retenu pour cette tranche. Consomme des minutes CI à un taux doublé par rapport à `ubuntu-latest` (coût CI additionnel non budgété sans accord explicite), alors que le besoin immédiat (produire un `.exe` x64 valide) est entièrement couvert par le conteneur Wine gratuit. Pourra être reconsidéré si un smoke Windows réel automatisé devient un critère strict.
- ARM64 : non retenu. Antoine a confirmé un poste Intel/AMD (x64).
- Signature immédiate (OV/EV) : non retenue pour cette tranche — dépense à valider explicitement (voir coût ci-dessous), différée par décision d'Antoine.

## Coût de signature (préparé, non engagé)

Recherche de marché (2026), hors mandat de dépense — aucun achat effectué :

| Option | Fournisseur (indicatif) | Coût annuel approx. |
|---|---|---|
| OV (Organization Validation) | Sectigo | ~220 $ |
| OV | DigiCert | ~439 $ |
| EV (Extended Validation, nécessite un token matériel ou HSM cloud) | Sectigo | ~290–410 $ |
| EV | DigiCert | ~560–620 $ |

Remarque : un certificat **EV** supprime en général l'avertissement SmartScreen « Éditeur inconnu » dès la première exécution (réputation construite immédiatement via le token matériel), alors qu'un certificat **OV** nécessite que SmartScreen accumule une réputation au fil des téléchargements avant de cesser d'avertir — un délai qui peut durer plusieurs semaines à volumes faibles. Validité maximale 460 jours, délai d'émission 1 à 7 jours ouvrés selon le niveau. Decision à prendre par Antoine : aucune signature n'est achetée sans son accord explicite (dépense).

## Conséquences et limites

- Seul l'installateur NSIS Windows x64 est construit et vérifié statiquement ici ; le smoke d'installation/lancement/désinstallation réel reste à faire par Antoine sur son poste physique.
- L'installateur n'est pas signé : Windows SmartScreen affichera un avertissement « Éditeur inconnu » à la première exécution. Normal et attendu pour une RC non signée.
- La release Windows passe désormais par la pipeline `semantic-release` existante (asset GitHub Release), contrairement au `.deb` Linux qui reste une livraison privée hors pipeline (ADR 0002). Cette différence est intentionnelle, en réponse à la décision explicite d'Antoine sur ce canal de remise.
- Build et vérification statique uniquement vérifiés dans ce conteneur Docker Ubuntu 22.04 + Wine 11.0 ; aucun autre environnement de build n'est annoncé.
