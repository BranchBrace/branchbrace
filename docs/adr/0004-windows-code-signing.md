# ADR 0004 — Signature de code de l'installateur Windows

- Statut : accepté ; câblage livré, activation en attente du compte Azure
- Date : 2026-10-31
- Décideur : Antoine
- Remplace : la section « Signature » et « Coût de signature » de l'ADR 0003

## Contexte

L'installateur NSIS non signé (ADR 0003) déclenche l'écran SmartScreen « Windows a protégé votre
ordinateur ». Antoine dispose d'un SIREN et préfère garder la distribution d'origine (GitHub
Releases) plutôt que le Microsoft Store.

Faits vérifiés le 2026-10-31 (sources primaires en bas) :

- Depuis 2024, **aucun certificat (OV ni EV) ne supprime l'écran dès le premier
  téléchargement**. La réputation SmartScreen s'accumule par certificat au fil des
  téléchargements ; la remarque « EV = réputation immédiate » de l'ADR 0003 est caduque.
- Signer chaque release avec la même identité transmet cette réputation aux versions suivantes.
  Sans signature, chaque version (nouveau hash) repart de zéro.
- Seule une publication MSIX via le Microsoft Store supprime l'écran d'emblée (non retenue).
- Azure Artifact Signing (ex-Trusted Signing) est ouvert aux **organisations de l'UE** (pas aux
  particuliers hors États-Unis/Canada). Offre Basic : 9,99 $/mois, 5 000 signatures.

## Décision

Signer **tous** les binaires Windows (exécutable de l'application, désinstalleur, installateur)
avec **Azure Artifact Signing**, au nom de l'entité immatriculée, sur **chaque** release `rc` et
`main`.

Mise en œuvre, compatible avec le build Linux + Wine de l'ADR 0003 :

- `package.json` → `build.win.signtoolOptions.sign = ./scripts/sign-windows.cjs`
  (SHA-256 seul). electron-builder appelle ce hook pour chaque binaire.
- Le hook appelle **jsign** (signataire Authenticode Java, fonctionne sous Linux) ; ni
  `signtool.exe` ni le module PowerShell Azure ne tournent dans le conteneur Wine. Horodatage
  automatique avec Artifact Signing (certificats de 3 jours).
- `scripts/package-windows-release.sh` télécharge jsign 7.6 depuis Maven Central, **vérifie son
  SHA-256**, installe un JRE dans le conteneur, transmet les variables par nom (le jeton
  n'apparaît sur aucune ligne de commande), puis `scripts/verify-windows-signature.sh` échoue si
  l'installateur n'est pas signé ou si l'éditeur ne correspond pas.
- CI : connexion Azure par **OIDC** (aucun secret stocké), jeton d'accès
  `https://codesigning.azure.net` masqué dans les logs.
- Tant que la variable `WINDOWS_SIGNING_ENDPOINT` n'existe pas, le build reste non signé avec un
  avertissement CI ; dès qu'elle existe, une release non signée **échoue**.

## Activation — étapes côté Antoine (portail Azure, non automatisables)

1. Abonnement Azure payant, puis enregistrer le fournisseur de ressources
   `Microsoft.CodeSigning`.
2. Créer un compte **Artifact Signing**, offre Basic, région West Europe
   (point de terminaison `weu.codesigning.azure.net`).
3. Se donner le rôle **Artifact Signing Identity Verifier**, puis créer une **validation
   d'identité « Organization », Public Trust** avec les documents de l'entité (SIREN). Attendre
   l'approbation.
4. Créer un **profil de certificat Public Trust** lié à cette validation.
5. Créer une inscription d'application Entra ID avec **deux identifiants fédérés GitHub**
   (`repo:MonniHermes/git-workbench:ref:refs/heads/rc` et `…:ref:refs/heads/main`), puis lui
   attribuer le rôle **Artifact Signing Certificate Profile Signer** sur le profil.
6. Variables GitHub du dépôt (Settings → Secrets and variables → Actions → Variables) — ce ne sont
   pas des secrets :

| Variable | Valeur |
|---|---|
| `WINDOWS_SIGNING_ENDPOINT` | `weu.codesigning.azure.net` |
| `WINDOWS_SIGNING_ALIAS` | `<nom du compte>/<nom du profil>` |
| `WINDOWS_SIGNING_PUBLISHER` | CN exact du certificat (nom légal validé de l'entité) |
| `AZURE_TENANT_ID` | identifiant du tenant |
| `AZURE_CLIENT_ID` | identifiant de l'application Entra |

La release suivante sur `rc` sera signée.

## Vérification réalisée

- Tests unitaires `test/windows-signing.test.js` : hook câblé, arguments jsign, échec si la
  signature est exigée mais non configurée, téléchargement épinglé et vérifié.
- Build de bout en bout dans le conteneur Wine avec un keystore PKCS#12 auto-signé
  (`WINDOWS_SIGNING_STORETYPE=PKCS12`) : chemin de signature et de vérification exercé.
- **Non vérifié** : la signature réelle via Artifact Signing (compte inexistant à ce jour) et
  l'affichage de l'éditeur dans SmartScreen sur un poste Windows.

## Conséquences

- Coût : ~10 $/mois tant que le volume reste sous 5 000 signatures (3 signatures par release).
- L'avertissement SmartScreen persistera sur les premières versions signées, avec le nom de
  l'éditeur affiché ; il disparaît quand la réputation du certificat est acquise.
- Le build Windows prend une minute de plus (installation du JRE).

## Sources

- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/distribution-feature-status
- https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-change-sku
- https://ebourg.github.io/jsign/ (section « Signing with Azure Artifact Signing »)
