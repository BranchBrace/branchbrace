# Git Workbench

Application desktop locale de gestion Git pour développeurs, sans service hébergé ni télémétrie. Le code source est public sur GitHub mais reste propriétaire (`UNLICENSED`, tous droits réservés) ; voir `LICENSE`. Git Workbench n’est pas affilié à GitKraken et n’en reprend aucun code, marque, texte ou actif.

Le parcours MVP permet l’inspection locale de l’état, des 100 derniers commits et des diffs, le staging/unstaging par fichier entier, par bloc ou par ligne depuis la vue de diff (index relu et restauré s’il ne correspond pas exactement au choix), le commit explicite non vide et le push explicitement confirmé vers l’upstream affiché, vérifié après écriture distante. Il inclut la création et le changement sûrs de branches locales, le cherry-pick, le rebase et le rebase interactif (pick/drop/fixup). Git CLI doit être installé ; les hooks et credential helpers configurés par l’utilisateur sont respectés.

Le MVP n’inclut pas le staging partiel par hunk, la suppression de branches, le merge local, la résolution intégrée de conflits, le fetch/pull automatique, la force-push, les opérations reset/discard/amend/squash, les intégrations d’hébergeurs, la télémétrie, ni les comptes. Une opération de réécriture ou un conflit reste explicite et laisse une référence locale de récupération ainsi qu’un chemin d’abort Git. Un push confirmé transmet les commits à l’upstream choisi ; aucun transfert de dépôt n’est automatique.

Mises à jour : menu ☰ › « Mises à jour… ». Le canal **Stable** suit les versions de `main`, le canal **Bêta** y ajoute les préversions RC publiées depuis `rc`. La recherche n’interroge que l’API publique des releases GitHub, sur demande ou au démarrage si l’option est cochée (désactivée par défaut). Sous Windows, l’installateur est téléchargé, vérifié par SHA-256 puis lancé ; ailleurs, la page de la release s’ouvre. Voir `docs/adr/0005-mises-a-jour.md`.

Les plateformes supportées et les capacités effectivement vérifiées seront listées dans `docs/VERIFICATION.md` ; aucune cible n’est déclarée supportée avant un essai sur l’OS exact.
