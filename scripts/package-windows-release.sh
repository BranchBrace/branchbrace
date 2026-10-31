#!/bin/sh
# Build the Windows x64 NSIS installer using a public Docker image bundling Wine.
# electron-builder cannot invoke NSIS without wine (`spawn wine ENOENT`), which this
# Linux host/CI runner lacks natively. No paid service, no Windows host, no new
# external dependency: electronuserland/builder:wine is a public, free Docker Hub image.
# See docs/adr/0003-windows-installer.md.
set -eu

version="${1:-}"
if [ -z "$version" ]; then
  version="$(node -e "console.log(require('./package.json').version)")+$(git rev-parse --short HEAD)"
fi

image="${GIT_WORKBENCH_WIN_BUILD_IMAGE:-electronuserland/builder:wine}"

echo "Building Windows x64 installer v$version with $image"
docker run --rm \
  -v "$PWD:/project" \
  -w /project \
  -e ELECTRON_CACHE=/root/.cache/electron \
  -e ELECTRON_BUILDER_CACHE=/root/.cache/electron-builder \
  "$image" \
  sh -c "npm ci && npm run package:win -- -c.extraMetadata.version=$version"

exe=$(ls artifacts/*.exe 2>/dev/null | head -n 1 || true)
if [ -z "$exe" ] || [ ! -f "$exe" ]; then
  echo "No .exe produced in artifacts/" >&2
  exit 1
fi
sha256sum "$exe" | tee "$exe.sha256"
echo "Windows installer: $exe"
