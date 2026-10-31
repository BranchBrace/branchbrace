# ADR 0002 — Installateur Linux x64 du MVP

- Statut : accepté techniquement pour cette tranche
- Date : 2026-10-31
- Décideur : Takumi · Lead Dev général
- Contexte : [MON-643](/MON/issues/MON-643), sous [MON-629](/MON/issues/MON-629) ; complète la candidate `linux-unpacked` de [MON-634](/MON/issues/MON-634), qui n’était pas un installateur.

## Décision

Livrer le MVP Linux x64 sous forme de paquet Debian (`.deb`, cible electron-builder `deb`, arch `x64`), produit par `npm run package:linux`. Le paquet installe l’application dans `/opt/Git Workbench`, le lanceur `/usr/bin/git-workbench` (via `update-alternatives`) et l’entrée de bureau `git-workbench.desktop`; il déclare `git` en dépendance, puisque l’application pilote le Git CLI installé. `apt purge` le désinstalle proprement.

`npm run build` (CI) reste `electron-builder --dir` : la CI vérifie la compilation et l’empaquetage sans produire ni téléverser d’artefact, conformément aux règles du dépôt.

## Motif et alternatives

- `.deb` : format natif de l’unique plateforme vérifiable ici (Debian 13 x86_64); installation, dépendances système et désinstallation gérées par dpkg/apt; testable intégralement dans un conteneur jetable sans toucher l’hôte. Aucun service ni dépense.
- AppImage : non retenu. Ce n’est pas une installation (exécutable portable, pas de désinstallation gérée) et son lancement exige FUSE, absent du conteneur de test; il ne fermerait pas l’écart « installable ».
- RPM, Snap, Flatpak : non retenus. Aucun environnement de test RPM disponible; Snap/Flatpak supposent un store ou un runtime externe, hors mandat (pas de nouveau service externe, pas de distribution).
- `tar.gz` : non retenu, équivalent de la candidate unpacked, sans installation.

## Conséquences et limites

- Seul le `.deb` Linux x64 est vérifié, et seulement sur Debian 13 (trixie) x86_64 en conteneur. Aucune autre distribution, architecture ni OS n’est annoncé.
- Le sandbox Chromium utilise les espaces de noms utilisateur (cas par défaut de Debian 13). Le repli SUID `chrome-sandbox` choisi par le `postinst` sur un système sans user namespaces n’est pas vérifié.
- Le paquet n’est pas signé et n’est publié sur aucun dépôt APT : livraison privée uniquement, sans distribution externe.
- La version du paquet est fixée au build (`-c.extraMetadata.version=<version RC>[+<commit>]`) car semantic-release ne réécrit pas `package.json` ; un build postérieur au tag porte le commit en métadonnée.
- Le smoke installateur exerce l’app installée (lecture et rebase interactif sur un dépôt jetable) : il couvre les chemins qui diffèrent entre Node et Electron empaqueté, que `node --test` ne voit pas.
