// Traduit les refus Git renvoyés par le processus principal en messages lisibles. Le preload les transmet comme une
// Error dont le message est un JSON { code, recoveryRef, operation } ; tout autre message est un incident inattendu.
const MESSAGES = {
  'working-tree-not-clean': 'Des changements locaux ne sont pas commités. Committez-les (ou annulez-les) avant cette opération.',
  'unsafe-working-tree': 'Git refuse : l’opération écraserait des changements locaux non commités.',
  conflict: 'Conflit : Git s’est arrêté au milieu de l’opération. Résolvez les fichiers en conflit puis continuez, ou annulez l’opération.',
  'nothing-staged': 'Rien n’est indexé : ajoutez des fichiers à l’index avant de committer.',
  'commit-message-required': 'Un résumé de commit non vide est requis.',
  'push-rejected': 'Push refusé par le dépôt distant (il contient des commits que vous n’avez pas). Récupérez-les d’abord.',
  'push-indeterminate': 'Résultat du push incertain : la connexion s’est interrompue. Vérifiez la branche distante avant de réessayer.',
  'push-verification-failed': 'Le push s’est terminé mais la branche distante ne pointe pas sur votre commit. Vérifiez-la avant de réessayer.',
  'upstream-missing': 'Cette branche n’a pas de branche distante associée (upstream).',
  'upstream-changed': 'L’upstream de la branche a changé depuis l’affichage. Actualisez puis réessayez.',
  'invalid-branch-name': 'Nom de branche invalide.',
  'branch-not-found': 'Cette branche locale n’existe pas (ou plus). Actualisez la vue.',
  'invalid-revision': 'Commit ou branche introuvable.',
  'invalid-rebase-plan': 'Plan de rebase invalide : il ne correspond plus aux commits de la branche. Actualisez puis recommencez.',
  'repository-not-open': 'Ce dépôt n’est plus ouvert. Rouvrez-le depuis le bouton ＋.',
  'repository-mismatch': 'Le dossier ne correspond plus au dépôt ouvert (déplacé ou supprimé ?). Fermez l’onglet et rouvrez le dépôt.',
  'not-a-repository': 'Ce dossier n’est pas un dépôt Git.',
  'file-not-in-status': 'Ce fichier n’apparaît plus dans les changements locaux. Actualisez la vue.',
  'file-not-in-commit': 'Ce fichier ne fait pas partie de ce commit.',
  'invalid-path': 'Chemin de fichier invalide.',
  'git-missing': 'Git est introuvable sur cet ordinateur. Installez Git puis relancez l’application.',
  'git-launch-failed': 'Impossible de lancer Git.',
  'git-output-too-large': 'La sortie de Git est trop volumineuse pour être affichée.',
  'git-operation-failed': 'Git a refusé l’opération.',
  'fetch-failed': 'Récupération impossible depuis le dépôt distant (réseau, authentification ou dépôt introuvable).',
  'branch-exists': 'Une branche locale porte déjà ce nom : basculez dessus plutôt que de la recréer.',
  'file-not-in-conflict': 'Ce fichier n’est plus en conflit. Actualisez la vue.',
  'conflicts-remaining': 'Des fichiers sont encore en conflit : résolvez-les tous avant de continuer.',
  'no-operation': 'Aucune opération Git n’est en cours.',
  'operation-cannot-skip': 'Un merge ne peut pas passer un commit : terminez-le ou annulez-le.',
  'operation-in-progress': 'Une opération Git (rebase, cherry-pick, merge) est en cours : terminez-la ou annulez-la d’abord.',
  'nothing-to-undo': 'Rien à annuler : aucun point de reprise en attente dans ce dépôt.',
  'nothing-to-redo': 'Rien à rétablir : aucun Undo récent, ou une opération a eu lieu depuis.',
  'recovery-would-rewrite-published': 'Annulation refusée : elle retirerait de la branche un commit déjà poussé sur son upstream. Utilisez un revert pour défaire un commit publié.',
  'recovery-point-other-branch': 'Ce point de reprise concerne une autre branche : basculez dessus pour l’annuler.',
  'recovery-point-not-found': 'Ce point de reprise n’existe plus.',
  'invalid-operation': 'Nom d’opération invalide pour un point de reprise.',
  'invalid-recovery-ref': 'Référence invalide pour un point de reprise (branche ou tag local attendu).',
  'invalid-content':'Contenu de fichier invalide.',
  'file-not-editable': 'Ce fichier est binaire ou trop volumineux pour l’éditeur.',
  'remote-no-web': 'Ce dépôt distant n’a pas de page web connue (URL locale ou non reconnue).',
  'update-check-failed': 'Impossible de joindre GitHub pour rechercher une mise à jour (hors ligne, proxy ou limite de l’API). Réessayez plus tard.',
  'invalid-update-channel': 'Canal de mise à jour inconnu.',
  'update-not-available': 'Aucune mise à jour à installer : relancez la recherche.',
  'update-in-progress': 'Une mise à jour est déjà en cours de téléchargement.',
  'update-download-failed': 'Le téléchargement de la mise à jour a échoué. Réessayez, ou installez-la depuis la page de la release.',
  'update-checksum-mismatch': 'L’installateur téléchargé ne correspond pas à son empreinte SHA-256 publiée : il a été supprimé sans être lancé.',
  'update-launch-failed': 'L’installateur a été téléchargé mais n’a pas pu être lancé.',
};

export function describeError(error) {
  let detail = null;
  try { detail = JSON.parse(error?.message); } catch { /* message non structuré */ }
  if (!detail?.code) return 'Échec inattendu de l’opération. Les données sensibles ne sont pas affichées.';
  let text = MESSAGES[detail.code] || `Git a refusé l’opération (${detail.code}).`;
  if (detail.code === 'conflict' && detail.operation) text += ` Pour annuler : git ${detail.operation} --abort.`;
  if (detail.recoveryRef) text += ` Point de récupération conservé : ${detail.recoveryRef}.`;
  return text;
}
