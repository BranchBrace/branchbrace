# Git Workbench

Client Git de bureau, local, pour un développeur solo à l'aise avec Git. Chaque action qui modifie un dépôt est explicite et doit pouvoir être annulée.

## Language

### Sécurité des opérations

**Opération destructive** :
Action qui peut faire perdre un commit, une ref ou une modification du dépôt local, par exemple un reset hard, la suppression d'une branche ou d'un tag, ou l'abandon de modifications. Elle n'est autorisée qu'après un point de reprise.
_Avoid_: action dangereuse, opération risquée

**Point de reprise** :
État du dépôt enregistré par l'application juste avant une opération destructive ou une réécriture d'historique. Il contient les refs et, si l'opération touche le working tree, les modifications non commitées. Restaurer ce point annule l'opération.
_Avoid_: backup, sauvegarde, snapshot, recovery ref (nom technique)

**Undo** :
Restauration du dernier point de reprise. Il ne s'applique qu'au dépôt local et ne réécrit jamais un commit déjà poussé.
_Avoid_: rollback, revert (qui désigne une autre opération Git)

**Redo** :
Restauration de l'état qui précédait le dernier Undo. Cet état est lui-même enregistré comme point de reprise au moment de l'Undo.

**Push forcé** :
Push qui remplace l'historique de l'upstream affiché. Il est toujours protégé par un « lease » : il échoue si l'upstream a changé depuis le dernier fetch. C'est une action distincte du push, jamais un repli automatique quand un push est rejeté.
_Avoid_: force push (sans lease)

### Historique

**Apport** :
Changements qu'une ref B introduit par rapport à une ref A depuis leur ancêtre commun. C'est ce qu'une PR montrerait. C'est le mode de comparaison par défaut.
_Avoid_: diff de branche, delta

**Différence directe** :
Écart brut entre les états de deux refs, qui mélange les changements faits de chaque côté.
_Avoid_: diff (seul)

### Identités

**Profil** :
Identité Git nommée : nom, email, clé de signature avec son format (GPG ou SSH), et comptes fournisseurs associés. Il s'applique à un dépôt en écrivant sa configuration locale, si bien que l'application et le terminal utilisent la même identité.
_Avoid_: compte, utilisateur, identité (seule)

**Profil par défaut** :
Profil proposé pour un dépôt qui n'en a pas encore. Il ne remplace jamais le profil déjà associé à un dépôt.

### Organisation des dépôts

**Onglet de dépôt** :
Dépôt ouvert dans la fenêtre. Les onglets de la dernière session sont rouverts au démarrage.

**Workspace** :
Ensemble nommé de dépôts, ouvert d'un coup en onglets. Il peut porter un profil par défaut. Il reste local à la machine.
_Avoid_: projet, groupe, espace de travail

### Remotes et identifiants

**Fournisseur** :
Service d'hébergement qui sert un remote, par exemple GitHub ou GitLab, et auquel l'utilisateur peut se connecter.
_Avoid_: hébergeur, forge, provider

**Connexion déléguée** :
Accès à un fournisseur géré par le credential helper du Git système (Git Credential Manager), sans que l'application ne voie ni ne stocke le secret. C'est le mode par défaut.

**Coffre** :
Stockage, dans le trousseau du système d'exploitation, de jetons d'accès personnels (PAT) que l'application gère elle-même pour un fournisseur. C'est une option, pour les comptes que la connexion déléguée ne couvre pas.
_Avoid_: keychain (nom technique), wallet
