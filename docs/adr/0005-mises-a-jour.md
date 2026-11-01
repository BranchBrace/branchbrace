# ADR 0005 — Mises à jour depuis les releases GitHub, canal stable ou bêta

- Statut : accepté
- Date : 2026-11-01
- Décideur : Antoine
- Complète : l'ADR 0001 (le réseau n'était sollicité que par un push explicite)

## Contexte

Les versions sont publiées par semantic-release sur GitHub Releases : `main` produit les versions
stables, `rc` les préversions (`x.y.z-rc.n`, marquées *pre-release*). Chaque release porte
l'installateur Windows NSIS et son empreinte `.sha256`. Il fallait pouvoir mettre l'application à
jour sans quitter l'interface, en choisissant de suivre ou non les préversions. Le dépôt est rendu
public pour que l'API des releases et les téléchargements soient accessibles sans jeton.

## Décision

- Menu de l'application › « Mises à jour… » : choix du canal, recherche, installation.
- Canal **Stable** : la plus haute version SemVer parmi les releases non *pre-release*.
  Canal **Bêta** : la plus haute version parmi toutes les releases, préversions RC comprises.
  Sans choix enregistré, une version installée en préversion suit le canal bêta.
- Seule l'API publique `api.github.com/repos/BranchBrace/branchbrace/releases` est interrogée,
  depuis le processus principal (`net.fetch`, proxy système respecté), sans identifiant ni donnée de
  dépôt. La recherche n'a lieu que sur clic, ou au démarrage si l'utilisateur coche l'option
  (désactivée par défaut) : la promesse « pas de réseau sans action explicite » de l'ADR 0001 tient.
- Windows (application installée) : après confirmation, l'installateur est téléchargé depuis
  `github.com/BranchBrace/branchbrace/releases/download/`, son SHA-256 est comparé à l'empreinte
  publiée, puis il est lancé et l'application se ferme. Une empreinte divergente supprime le fichier
  sans le lancer. Aucune URL ne vient de la page : le processus principal n'installe que la release
  qu'il a lui-même trouvée.
- Autres plateformes et mode développement : aucun installateur publié, le bouton ouvre la page de
  la release dans le navigateur.

## Alternatives écartées

- **electron-updater** : demande de publier `latest.yml` et ajoute une dépendance d'exécution, pour
  un gain limité (installation silencieuse, différentiel) tant que la signature n'est pas active.
- **Vérification automatique par défaut** : contredirait l'engagement « réseau seulement sur action
  explicite » ; elle reste un choix de l'utilisateur.

## Conséquences

- L'empreinte SHA-256 vient de la même release que l'installateur : elle protège contre un
  téléchargement corrompu, pas contre une release compromise. La signature Authenticode (ADR 0004)
  couvrira l'authenticité une fois activée.
- Un passage du canal bêta au canal stable ne propose jamais de retour à une version inférieure : on
  attend la version stable suivante.
