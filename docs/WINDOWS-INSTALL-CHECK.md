# Vérification manuelle — installateur Windows x64 (Antoine)

Ce document complète `docs/adr/0003-windows-installer.md` : le build et les contrôles
statiques (somme SHA-256, en-tête PE, taille) sont vérifiés en CI/local sans Windows ;
l'installation, le lancement et la désinstallation réels ne peuvent être vérifiés que
sur une vraie machine Windows. C'est la vérification que tu as choisi de faire toi-même.

## 1. Récupérer l'installateur

Sur https://github.com/MonniHermes/git-workbench/releases, prendre la **dernière
pré-release** (tag `vX.Y.Z-rc.N`) et télécharger :
- `BranchBrace Setup <version>.exe`
- `BranchBrace Setup <version>.exe.sha256`

## 2. Vérifier l'empreinte (PowerShell)

```powershell
Get-FileHash ".\BranchBrace Setup <version>.exe" -Algorithm SHA256
```

Comparer la valeur affichée au contenu du fichier `.sha256` téléchargé : elles doivent
être identiques (champ hexadécimal, insensible à la casse).

## 3. Installer

Double-clic sur le `.exe`. Comme l'installateur n'est pas signé (décision « sign_later »
du 2026-10-31, coût préparé dans l'ADR), Windows SmartScreen affichera **« Windows a
protégé votre ordinateur »** : cliquer sur « Informations complémentaires » puis
« Exécuter quand même ». C'est l'avertissement normal pour une RC non signée, pas un
dysfonctionnement.

Vérifier pendant l'assistant :
- Le titre affiche bien la version RC attendue.
- L'écran d'installation ne demande **pas** les droits administrateur (installation par
  utilisateur, chemin par défaut sous `%LOCALAPPDATA%\Programs\BranchBrace`).

## 4. Lancer et tester

- Lancer « BranchBrace » depuis le menu Démarrer ou le raccourci bureau.
- Ouvrir un dépôt Git existant (ou en créer un jetable).
- Faire un commit, puis un **rebase interactif** (réordonner/squasher deux commits) :
  c'est le correctif packagé de MON-645 que cette tranche doit confirmer sous Windows.
- Noter tout comportement anormal (écran blanc, erreur au lancement, rebase qui échoue).

## 5. Désinstaller

Paramètres > Applications > Applications installées > « BranchBrace » > Désinstaller.
Vérifier ensuite que `%LOCALAPPDATA%\Programs\BranchBrace` n'existe plus.

## 6. Rapporter le résultat

Commenter sur l'issue MON-647 avec : version testée, résultat de chaque étape
(installation / lancement / rebase interactif / désinstallation), et toute anomalie
rencontrée (avec capture d'écran si pertinent). C'est ce retour qui permettra de
clore la vérification Windows du MVP.
