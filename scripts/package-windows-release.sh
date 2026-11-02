#!/bin/sh
# Build the Windows x64 NSIS installer and portable executable using a public Docker image bundling Wine.
# electron-builder cannot invoke NSIS without wine (`spawn wine ENOENT`), which this
# Linux host/CI runner lacks natively. No paid service, no Windows host, no new
# external dependency: electronuserland/builder:wine is a public, free Docker Hub image.
# See docs/adr/0003-windows-installer.md.
#
# Code signing (docs/adr/0004-windows-code-signing.md): when WINDOWS_SIGNING_KEYSTORE is
# set, every Windows binary is signed with jsign through scripts/sign-windows.cjs and the
# build fails rather than ship an unsigned installer. Without it, the build stays unsigned.
set -eu

version="${1:-}"
if [ -z "$version" ]; then
  version="$(node -e "console.log(require('./package.json').version)")+$(git rev-parse --short HEAD)"
fi

image="${BRANCHBRACE_WIN_BUILD_IMAGE:-electronuserland/builder:wine}"

# The image runs as root, so files it writes into the bind-mounted artifacts/
# directory are root-owned on the host. Chown them back to the invoking user
# before the container exits, so the host-side sha256sum/tee step below (run
# as a normal user, e.g. the GitHub Actions runner) can read and write there.
host_uid="$(id -u)"
host_gid="$(id -g)"

jsign_version="7.6"
jsign_sha256="6cf58aa080e7ff82656f320cff8d4a3bff30408df8766806dcba3740dd839fa5"
jsign_jar=".cache/jsign/jsign-$jsign_version.jar"

signing_setup=""
signing_check=""
if [ -n "${WINDOWS_SIGNING_KEYSTORE:-}" ]; then
  echo "Code signing enabled (${WINDOWS_SIGNING_STORETYPE:-TRUSTEDSIGNING})"
  if [ ! -f "$jsign_jar" ]; then
    mkdir -p "$(dirname "$jsign_jar")"
    curl -fsSL -o "$jsign_jar" "https://repo1.maven.org/maven2/net/jsign/jsign/$jsign_version/jsign-$jsign_version.jar"
  fi
  echo "$jsign_sha256  $jsign_jar" | sha256sum -c -
  # Values are forwarded by name (-e VAR) so the access token never appears on a command line.
  export JSIGN_JAR="/project/$jsign_jar" WINDOWS_SIGNING_REQUIRED=1
  set -- -e JSIGN_JAR -e WINDOWS_SIGNING_REQUIRED -e WINDOWS_SIGNING_KEYSTORE -e WINDOWS_SIGNING_ALIAS \
    -e WINDOWS_SIGNING_STOREPASS -e WINDOWS_SIGNING_STORETYPE -e WINDOWS_SIGNING_PUBLISHER \
    -e AZURE_TENANT_ID -e AZURE_CLIENT_ID -e AZURE_CLIENT_SECRET
  signing_setup="apt-get update -qq && apt-get install -y -qq --no-install-recommends openjdk-17-jre-headless >/dev/null && "
  signing_check=" && sh scripts/verify-windows-signature.sh artifacts/*.exe"
else
  echo "::warning::WINDOWS_SIGNING_KEYSTORE not set: the Windows installer is NOT signed (SmartScreen will warn)."
  set --
fi

echo "Building Windows x64 installer and portable v$version with $image"
docker run --rm \
  -v "$PWD:/project" \
  -w /project \
  -e ELECTRON_CACHE=/root/.cache/electron \
  -e ELECTRON_BUILDER_CACHE=/root/.cache/electron-builder \
  "$@" \
  "$image" \
  sh -c "${signing_setup}npm ci && npm run package:win -- -c.extraMetadata.version=$version${signing_check}; status=\$?; chown -R $host_uid:$host_gid artifacts .cache 2>/dev/null; exit \$status"

# One installer (NSIS) and one portable build (no installation): each gets its own published checksum.
for kind in Setup portable; do
  exe=$(ls artifacts/*"$kind"*.exe 2>/dev/null | head -n 1 || true)
  if [ -z "$exe" ] || [ ! -f "$exe" ]; then
    echo "No $kind .exe produced in artifacts/" >&2
    exit 1
  fi
  sha256sum "$exe" | tee "$exe.sha256"
  echo "Windows $kind: $exe"
done
