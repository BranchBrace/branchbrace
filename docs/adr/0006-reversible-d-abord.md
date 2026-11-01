# ADR 0006 — Réversible d'abord : opérations destructives, push forcé et coffre

- Statut : accepté
- Date : 2026-11-01
- Décideur : Antoine
- Remplace : A3, A12, le « jamais de force-push » de A6, le « l'app ne collecte pas d'identifiants » de la section Sécurité, et une partie de la liste « Explicitly out of scope for v1 » de `docs/MVP.md`

## Contexte

Le MVP interdisait toute opération destructive (reset, discard, suppression de branche) et tout push forcé. Comparé à GitKraken, ce choix privait l'app de fonctions courantes : Undo, reset, stash, suppression de branche ou de tag. Il créait aussi une contradiction. B5 permet d'amender un commit déjà poussé, mais le résultat ne pouvait être poussé que depuis un terminal.

## Décision

**Réversible d'abord.** Une opération destructive est autorisée à trois conditions, dans cet ordre :

1. une action explicite de l'utilisateur ;
2. une confirmation ;
3. un point de reprise enregistré *avant* d'agir.

Le point de reprise étend les refs `refs/branchbrace/recovery/*` déjà utilisées pour l'amend, le cherry-pick et le rebase. Quand l'opération touche le working tree (reset hard, discard), il enregistre aussi les modifications non commitées, avec `git stash create` pour ne pas toucher à la pile de stash.

L'Undo restaure le dernier point de reprise. Le Redo restaure l'état enregistré au moment de l'Undo. Les deux restent limités au dépôt local et ne réécrivent jamais un commit déjà poussé.

**Push forcé avec lease uniquement.** Le push forcé :

- utilise toujours `--force-with-lease` ;
- ne vise que l'upstream affiché ;
- est une action distincte du push, jamais un repli automatique quand un push est rejeté ;
- est précédé d'une confirmation qui liste les commits distants qui vont disparaître.

Aucun point de reprise ne peut exister côté serveur. Le point de reprise local conserve les anciens commits.

**Identifiants : connexion déléguée par défaut, coffre en option.** Par défaut, Git Credential Manager gère l'accès aux fournisseurs ; l'app ne voit pas le secret. En option, l'app stocke des jetons d'accès personnels dans le trousseau de l'OS (jamais en clair) et les fournit à Git. Une URL de remote qui contient des identifiants est refusée.

## Options écartées

- **Garder le « jamais »** : cohérent, mais incompatible avec l'Undo et avec l'amend d'un commit poussé.
- **Confirmation seule, sans point de reprise** : c'est ce que font la plupart des clients Git. Une erreur de clic resterait alors définitive.
- **Push forcé interdit sur la branche par défaut** : ajoute de la configuration et une exception à expliquer, pour un utilisateur solo.
- **Jeton dans l'URL du remote** : il serait stocké en clair dans `.git/config`.

## Conséquences

- Un point de reprise peut contenir des modifications non commitées. Leur nettoyage (durée de conservation, purge) reste à définir.
- Le stash est toujours manipulé par SHA, car sa pile est partagée entre les worktrees d'un dépôt.
- Le coffre fait de l'app un détenteur de secrets. Il ne doit jamais les journaliser (A10, A16).
