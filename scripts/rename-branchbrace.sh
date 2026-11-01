#!/usr/bin/env bash
# Renomme Git Workbench en BranchBrace. À relancer sur main une fois les PR en cours fusionnées.
# Les URL du dépôt MonniHermes, l'alias de signature et les images ghcr restent inchangés
# jusqu'au transfert du dépôt ; l'ADR 0003 et le CHANGELOG gardent l'ancien nom comme trace.
# L'appId reste com.monnishermes.gitworkbench : sous Windows, en changer installerait une seconde application au lieu
# de mettre à jour la première.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

files=$(git grep -il "git.workbench\|gitworkbench" -- . ':!package-lock.json' ':!CHANGELOG.md' \
  ':!docs/adr/0003-windows-installer.md' ':!scripts/rename-branchbrace.sh' || true)
[ -z "$files" ] && { echo "Rien à renommer."; exit 0; }

sed -i \
  -e 's#MonniHermes/git-workbench#@@GHREPO@@#g' \
  -e 's#monnier/git-workbench#@@ALIAS@@#g' \
  -e 's#monnihermes/git-workbench-#@@GHCR@@#g' \
  -e 's#^repo="git-workbench"#@@GHCRREPO@@#' \
  -e "s#'Git Workbench'); // ancien nom#@@LEGACY@@#" \
  -e 's#GitWorkbenchError#BranchBraceError#g' \
  -e 's#GIT_WORKBENCH#BRANCHBRACE#g' \
  -e 's#Git Workbench#BranchBrace#g' \
  -e 's#git-workbench#branchbrace#g' \
  -e 's#@@GHREPO@@#MonniHermes/git-workbench#g' \
  -e 's#@@ALIAS@@#monnier/git-workbench#g' \
  -e 's#@@GHCR@@#monnihermes/git-workbench-#g' \
  -e 's#@@GHCRREPO@@#repo="git-workbench"#' \
  -e "s#@@LEGACY@@#'Git Workbench'); // ancien nom#" \
  $files
sed -i '1,12s#"name": "git-workbench"#"name": "branchbrace"#' package-lock.json

echo "Renommé dans $(echo "$files" | wc -l) fichiers. Restes à vérifier :"
git grep -in "git.workbench\|gitworkbench" -- . ':!CHANGELOG.md' ':!docs/adr/0003-windows-installer.md' \
  ':!scripts/rename-branchbrace.sh' | grep -v "MonniHermes/git-workbench\|monnier/git-workbench\|monnihermes/git-workbench-\|com.monnishermes.gitworkbench\|^scripts/release-images.sh:.*repo=\|// ancien nom" || echo "aucun"
