#!/bin/sh
# Régénère les icônes de l'application depuis build/icon.svg (ImageMagick 7 requis : commande « magick »).
#   build/icon.png, build/icon.ico : icône de l'exécutable Windows (electron-builder les prend dans build/).
#   build/appx/*.png               : logos du paquet MSIX publié sur le Microsoft Store (cible « appx »).
# Les fichiers produits sont versionnés ; ce script ne sert qu'après une modification de l'icône.
set -eu
cd "$(dirname "$0")/.."
svg=build/icon.svg
bg='#0c1328'
render() { magick -background none -density 384 "$svg" -resize "$1x$1" "$2"; }
# Logo carré centré sur un fond de la couleur de l'icône, pour les formats non carrés (tuile large).
banner() { magick -size "$1x$2" "xc:$bg" \( -background none -density 384 "$svg" -resize "$3x$3" \) -gravity center -composite "$4"; }

mkdir -p build/appx
render 512 build/icon.png
magick -background none -density 384 "$svg" -define icon:auto-resize=256,128,64,48,32,24,16 build/icon.ico

for scale in 100 200; do
  render $((44 * scale / 100)) "build/appx/Square44x44Logo.scale-$scale.png"
  render $((150 * scale / 100)) "build/appx/Square150x150Logo.scale-$scale.png"
  render $((50 * scale / 100)) "build/appx/StoreLogo.scale-$scale.png"
  banner $((310 * scale / 100)) $((150 * scale / 100)) $((120 * scale / 100)) "build/appx/Wide310x150Logo.scale-$scale.png"
done
for size in 16 24 32 48 256; do
  render "$size" "build/appx/Square44x44Logo.targetsize-$size.png"
  render "$size" "build/appx/Square44x44Logo.targetsize-${size}_altform-unplated.png"
done
