# Publication sur le Microsoft Store

BranchBrace est publié sur le Microsoft Store en paquet MSIX, en plus de l'installateur NSIS et de la version portable des releases GitHub.

## Identité du paquet

Valeurs réservées dans Partner Center (compte développeur individuel « Antoine Monnier », commun à terragrunt-tui) et reprises dans la section `build.appx` de [`package.json`](../package.json) :

| Champ | Valeur |
|---|---|
| Name | `AntoineMonnier.BranchBrace` |
| Publisher | `CN=94794141-B9ED-4FA9-B74B-C1FC94E6B207` |
| PublisherDisplayName | `Antoine Monnier` |
| Store ID | `9N8TKSZ4DW55` |

## Le paquet

- Cible electron-builder `appx`, script `npm run package:msix`. Le paquet sort dans `artifacts\BranchBrace-X.Y.Z.appx`.
- Le `makeappx.exe` embarqué par electron-builder plante : [`scripts/package-msix.ps1`](../scripts/package-msix.ps1) pointe `ELECTRON_BUILDER_WINDOWS_KITS_PATH` vers le `makeappx.exe` et le `makepri.exe` du Windows SDK installé.
- Paquet non signé : le Store le signe après certification. Aucun certificat n'est nécessaire.
- Version : le Store impose 4 parties, la dernière à 0, en hausse à chaque soumission. `X.Y.Z` devient `X.Y.Z.0` ; le script vérifie la version et l'identité inscrites dans l'`AppxManifest.xml` du paquet. Seules les releases stables sont publiées.
- Logos : `build/appx/`, générés depuis `build/icon.svg` par `scripts/render-icons.sh`.
- Langue unique `fr-FR`.
- Dans la version Store (`process.windowsStore`), aucun installateur n'est téléchargé depuis GitHub : le dialogue Mises à jour renvoie vers la fiche du Store.

## Publier une nouvelle version

C'est automatique. Quand le pipeline `quality-release` publie une release stable sur `main`, il appelle [`.github/workflows/store.yml`](../.github/workflows/store.yml). Ce workflow tourne sur un runner Windows :

1. il construit le MSIX depuis le tag avec `scripts/package-msix.ps1` ;
2. il le soumet avec [`scripts/publish-store.ps1`](../scripts/publish-store.ps1), qui passe par l'API de soumission du Microsoft Store.

Le job `release` repère la release stable à l'étape « Stable release tag » : semantic-release tague en local son commit de release avant de le pousser par la clé de déploiement, donc `HEAD` ne porte un tag `vX.Y.Z` que si ce run vient de publier une version stable. Les release candidates de `rc` ne vont jamais au Store.

La nouvelle soumission reprend la fiche, le prix et la classification de la précédente. Seul le paquet change : l'ancien est retiré. La soumission part en certification puis est publiée automatiquement si elle passe, ce qui prend de quelques heures à 3 jours ouvrés.

L'API refuse de créer une soumission tant qu'une autre est en cours. Le job échoue alors avec un message clair. Il faut terminer ou supprimer la soumission en cours dans Partner Center, puis relancer le workflow `microsoft-store` à la main avec le tag, `dry_run` décoché.

### Authentification

Aucun secret n'est stocké. Le job se connecte par OIDC à l'application Entra **github-store-submission**, distincte de l'application de signature (`AZURE_CLIENT_ID`) :

- tenant `55a83d13-da5a-48c1-8d14-32229bee09ec` ;
- client `d39b44b7-6b1a-47ec-beda-a212c4224024` ;
- variables du dépôt `STORE_TENANT_ID` et `STORE_CLIENT_ID` ;
- identité fédérée pour la branche `main` de branchbrace (et de terragrunt-tui).

L'application est associée au compte Partner Center avec le rôle **Gestionnaire** : Paramètres du compte > Gestion des utilisateurs > Applications Microsoft Entra.

### Vérifier sans soumettre

Lancer le workflow `microsoft-store` à la main, sur `main`, avec `dry_run` coché et le dernier tag stable :

```powershell
gh workflow run store.yml -R BranchBrace/branchbrace --ref main -f tag=vX.Y.Z -f dry_run=true
```

Le dry run construit le MSIX depuis le commit du workflow avec la version du tag, puis vérifie l'accès à l'application dans Partner Center et l'absence de soumission en cours. Rien n'est soumis.

### À la main

Sur un poste Windows avec Node 22 et le Windows SDK, depuis le tag :

```powershell
git checkout vX.Y.Z
npm ci
pwsh scripts/package-msix.ps1 -Version X.Y.Z
```

Deux façons de soumettre le paquet produit :

- dans Partner Center : **Mettre à jour** la soumission, **Packages**, téléverser le paquet, puis **Soumettre pour certification** ;
- en ligne de commande, après un `az login` sur un compte qui a accès à Partner Center : `pwsh scripts/publish-store.ps1 -Msix <paquet>`.
