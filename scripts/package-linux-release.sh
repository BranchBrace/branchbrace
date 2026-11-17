#!/bin/sh
# Build the Linux x64 .deb in a public Docker image, so the build runs the same way on the
# CI runner and on a Windows or macOS workstation (electron-builder only builds .deb on Linux).
# Same image as the Windows build by default: one pull, one toolchain. See docs/adr/0002-linux-installer.md.
set -eu

version="${1:-}"
if [ -z "$version" ]; then
  version="$(node -e "console.log(require('./package.json').version)")+$(git rev-parse --short HEAD)"
fi

image="${BRANCHBRACE_LINUX_BUILD_IMAGE:-electronuserland/builder:wine}"

# The image runs as root: chown what it writes back to the invoking user (see package-windows-release.sh).
host_uid="$(id -u)"
host_gid="$(id -g)"

echo "Building Linux x64 .deb v$version with $image"
docker run --rm \
  -v "$PWD:/project" \
  -w /project \
  -e ELECTRON_CACHE=/root/.cache/electron \
  -e ELECTRON_BUILDER_CACHE=/root/.cache/electron-builder \
  "$image" \
  sh -c "npm ci && npm run package:linux -- -c.extraMetadata.version=$version; status=\$?; chown -R $host_uid:$host_gid artifacts node_modules dist out 2>/dev/null; exit \$status"

deb=$(ls artifacts/*.deb 2>/dev/null | head -n 1 || true)
if [ -z "$deb" ] || [ ! -f "$deb" ]; then
  echo "No .deb produced in artifacts/" >&2
  exit 1
fi
(cd "$(dirname "$deb")" && sha256sum "$(basename "$deb")" | tee "$(basename "$deb").sha256")
echo "Linux deb: $deb"
