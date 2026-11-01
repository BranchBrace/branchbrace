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
  'branch-name-taken': 'Une branche locale porte déjà ce nom. Git ne remplace jamais une branche existante : choisissez un autre nom, ou supprimez d’abord l’autre branche vous-même.',
  'branch-name-taken-remote': 'Ce nom existe déjà sur le dépôt distant : rien n’a été renommé. Choisissez un autre nom.',
  'remote-rename-diverged': 'La branche distante ne pointe pas sur le même commit que la branche locale (commits à pousser ou à récupérer) : rien n’a été renommé. Synchronisez-les d’abord, ou renommez seulement en local.',
  'remote-rename-publish-failed': 'Branche renommée en local, mais la publication du nouveau nom sur le dépôt distant a échoué (push refusé, vérification impossible ou suivi non configuré). L’ancienne branche distante est intacte : poussez le nouveau nom vous-même, ou renommez à nouveau en local.',
  'remote-old-branch-kept': 'Branche renommée en local et nouveau nom poussé (il est désormais suivi), mais l’ancien nom n’a pas pu être supprimé du dépôt distant (il a changé entre-temps ou le serveur le protège). Supprimez-le vous-même si besoin.',
  'branch-in-other-worktree': 'Cette branche est déjà extraite dans une autre worktree : Git n’autorise qu’une worktree par branche. Ouvrez cette worktree (double-clic dans la section WORKTREES) plutôt que de basculer ici.',
  'worktree-dirty': 'Git refuse de supprimer cette worktree : elle contient des changements non commités ou des fichiers non suivis, qui seraient perdus. Committez-les ou déplacez-les d’abord.',
  'worktree-locked': 'Cette worktree est verrouillée (git worktree lock) : déverrouillez-la d’abord si vous voulez vraiment la supprimer.',
  'worktree-path-inside-worktree': 'Le dossier choisi est à l’intérieur d’une worktree du dépôt (ou de sa copie principale) : la nouvelle worktree y apparaîtrait comme un dossier non suivi. Choisissez un dossier en dehors.',
  'worktree-path-exists': 'Le dossier choisi existe déjà et n’est pas vide : choisissez un dossier vide ou à créer.',
  'worktree-not-found': 'Cette worktree n’existe plus (ou son dossier a disparu). Actualisez la vue.',
  'worktree-main': 'La worktree principale du dépôt ne peut pas être supprimée.',
  'worktree-current': 'Cette worktree est celle de l’onglet courant : ouvrez une autre worktree pour la supprimer depuis celle-ci.',
  'branch-not-found':'Cette branche locale n’existe pas (ou plus). Actualisez la vue.',
  'invalid-revision': 'Commit ou branche introuvable.',
  'invalid-rebase-plan': 'Plan de rebase invalide : il ne correspond plus aux commits de la branche. Actualisez puis recommencez.',
  'repository-not-open': 'Ce dépôt n’est plus ouvert. Rouvrez-le depuis le bouton ＋.',
  'repository-mismatch': 'Le dossier ne correspond plus au dépôt ouvert (déplacé ou supprimé ?). Fermez l’onglet et rouvrez le dépôt.',
  'not-a-repository': 'Ce dossier n’est pas un dépôt Git.',
  'file-not-in-status': 'Ce fichier n’apparaît plus dans les changements locaux. Actualisez la vue.',
  'file-not-in-commit': 'Ce fichier ne fait pas partie de ce commit.',
  'invalid-path': 'Chemin de fichier invalide.',
  'extension-invalid': 'Ce fichier n’est pas une extension VS Code (.vsix) lisible.',
  'extension-no-grammar': 'Cette extension n’apporte aucune grammaire de coloration.',
  'extension-not-found': 'Cette extension importée n’existe plus. Rouvrez la fenêtre des extensions.',
  'grammar-not-found': 'Grammaire de coloration introuvable.',
  'git-missing': 'Git est introuvable sur cet ordinateur. Installez Git puis relancez l’application.',
  'git-launch-failed': 'Impossible de lancer Git.',
  'git-output-too-large': 'La sortie de Git est trop volumineuse pour être affichée.',
  'git-operation-failed': 'Git a refusé l’opération.',
  'pull-verification-failed': 'Le pull s’est terminé mais la branche ne pointe pas sur le commit de sa distante. Actualisez et vérifiez avant de réessayer.',
  'invalid-fetch-interval': 'Intervalle de fetch automatique non pris en charge.',
  'fetch-failed':'Récupération impossible depuis le dépôt distant (réseau, authentification ou dépôt introuvable).',
  'branch-exists': 'Une branche locale porte déjà ce nom : basculez dessus plutôt que de la recréer.',
  'file-not-in-conflict': 'Ce fichier n’est plus en conflit. Actualisez la vue.',
  'conflicts-remaining': 'Des fichiers sont encore en conflit : résolvez-les tous avant de continuer.',
  'no-operation': 'Aucune opération Git n’est en cours.',
  'operation-cannot-skip': 'Un merge ne peut pas passer un commit : terminez-le ou annulez-le.',
  'merge-source-changed': 'La branche à merger a changé depuis la prévisualisation. Actualisez puis recommencez.',
  'nothing-to-merge': 'Rien à merger : la branche courante contient déjà tous ces commits.',
  'detached-head': 'Aucune branche n’est active (HEAD détachée) : basculez sur la branche à mettre à jour.',
  'operation-in-progress': 'Une opération Git (rebase, cherry-pick, merge) est en cours : terminez-la ou annulez-la d’abord.',
  'invalid-content': 'Contenu de fichier invalide.',
  'file-not-editable': 'Ce fichier est binaire ou trop volumineux pour l’éditeur.',
  'diff-outdated': 'Le fichier a changé depuis l’affichage du diff : rien n’a été indexé. Le diff a été rechargé, refaites la sélection.',
  'nothing-selected': 'La sélection ne contient aucune ligne ajoutée ou supprimée.',
  'partial-staging-unsupported': 'Indexation partielle impossible pour ce fichier (renommé, en conflit, binaire, lien symbolique, filtre Git ou fins de ligne CR seules) : indexez ou désindexez le fichier entier.',
  'partial-apply-failed': 'Git a refusé le patch partiel (index verrouillé par un autre processus Git ?) : l’index n’a pas été modifié.',
  'partial-verification-failed': 'Après application, l’index ne correspondait pas exactement aux lignes choisies : il a été restauré tel qu’avant l’opération. Indexez le fichier entier ou réessayez après actualisation.',
  'partial-restore-failed': 'L’index ne correspondait pas aux lignes choisies et n’a pas pu être restauré : vérifiez-le (git diff --cached) avant de committer.',
  'remote-no-web': 'Ce dépôt distant n’a pas de page web connue (URL locale ou non reconnue).',
  'update-check-failed': 'Impossible de joindre GitHub pour rechercher une mise à jour (hors ligne, proxy ou limite de l’API). Réessayez plus tard.',
  'invalid-update-channel': 'Canal de mise à jour inconnu.',
  'update-not-available': 'Aucune mise à jour à installer : relancez la recherche.',
  'update-in-progress': 'Une mise à jour est déjà en cours de téléchargement.',
  'update-download-failed': 'Le téléchargement de la mise à jour a échoué. Réessayez, ou installez-la depuis la page de la release.',
  'update-checksum-mismatch': 'L’installateur téléchargé ne correspond pas à son empreinte SHA-256 publiée : il a été supprimé sans être lancé.',
  'update-launch-failed': 'L’installateur a été téléchargé mais n’a pas pu être lancé.',
};

// Message d'un code connu, pour un avertissement renvoyé avec un résultat (succès partiel) plutôt qu'en erreur.
export const describeCode = (code) => MESSAGES[code] || `Git a signalé : ${code}.`;

export function describeError(error) {
  let detail = null;
  try { detail = JSON.parse(error?.message); } catch { /* message non structuré */ }
  if (!detail?.code) return 'Échec inattendu de l’opération. Les données sensibles ne sont pas affichées.';
  let text = MESSAGES[detail.code] || `Git a refusé l’opération (${detail.code}).`;
  if (detail.code === 'conflict' && detail.operation) text += ` Pour annuler : git ${detail.operation} --abort.`;
  if (detail.recoveryRef) text += ` Point de récupération conservé : ${detail.recoveryRef}.`;
  return text;
}
