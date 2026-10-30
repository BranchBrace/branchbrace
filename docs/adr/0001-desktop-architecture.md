# ADR 0001 — Architecture desktop MVP

- Statut : accepté techniquement pour cette tranche
- Date : 2026-10-30
- Décideur : Takumi · Lead Dev général
- Contexte produit/architecture : [MON-625](/MON/issues/MON-625), portée [MON-622](/MON/issues/MON-622), exécution autorisée par le plan [MON-629](/MON/issues/MON-629#document-plan), révision `647759b1-7ea1-4c56-b7db-fcdcae89e908`

## Décision

Construire un client desktop Electron avec UI web locale, processus principal Node.js et pont `contextBridge` étroit, sandbox activé, isolation de contexte activée et intégration Node désactivée dans le renderer. Utiliser le Git CLI installé par l’utilisateur comme moteur unique; lancer les processus avec des arguments structurés (jamais un shell), respecter la configuration Git existante, hooks et credential helpers compris. Pas de télémétrie, de compte ou de service hébergé.

## Motif et alternatives

L’ADR MON-625 recommandait d’évaluer Tauri 2, sans en faire un choix final. L’environnement d’exécution vérifié pour cette livraison n’a ni Rust/Cargo ni les dépendances natives GTK/WebKit requises par Tauri. Ce choix aurait empêché le build et l’essai de lancement sur l’unique environnement vérifiable ici. Electron a été retenu comme alternative explicitement envisagée dans MON-625 : Node 22 est disponible et Electron fournit un runtime desktop installable sur cet hôte. Il faut limiter strictement le pont natif et maintenir une CSP restrictive; cette décision ne prétend pas qu’Electron est plus sûr ou plus performant que Tauri.

Tauri 2 pourra remplacer Electron dans un ADR ultérieur seulement si un environnement doté de Rust et des dépendances natives permet une comparaison et une qualification réelle. Git CLI est retenu, sans fallback libgit2 ni exécution Git côté service.

## Contraintes de sécurité

- Aucun `nodeIntegration` dans le renderer; `contextIsolation` et `sandbox` activés.
- Le renderer ne reçoit que des opérations de domaine déterminées, jamais `exec`, une commande ou un chemin arbitraire pour le processus.
- Choisir le dépôt par boîte de dialogue native; valider qu’il s’agit d’un dépôt Git avant toute opération.
- Utiliser des arguments séparés et des chemins `--` délimités; ne jamais utiliser `shell: true`.
- Masquer les sorties sensibles et ne pas journaliser stdout/stderr bruts, URLs d’authentification ou valeurs credential-helper.
- Le réseau est seulement sollicité après action explicite de push vers l’upstream affiché; aucun fetch automatique ni télémétrie.

## Livraison et limites

La validation de cette tranche ne pourra annoncer que les systèmes effectivement lancés et testés. Les builds natifs Windows/macOS et la distribution restent hors de l’autorité de cette issue; aucun dépôt/publication externe n’est déclenché. Les opérations de branche, cherry-pick, rebase et rebase interactif restent soumises aux critères explicites de prévisualisation, confirmation et reprise de la spécification.