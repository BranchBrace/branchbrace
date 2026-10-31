#!/bin/sh
# Install, launch and purge the Linux x64 .deb inside a disposable Debian 13 container.
# The host package database and user environment are never touched (no host install, no privilege escalation).
set -eu

deb="${1:-}"
if [ -z "$deb" ]; then deb=$(ls artifacts/*.deb 2>/dev/null | head -n 1 || true); fi
if [ -z "$deb" ] || [ ! -f "$deb" ]; then echo "usage: $0 path/to/git-workbench_<version>_amd64.deb" >&2; exit 2; fi
dir=$(cd "$(dirname "$deb")" && pwd)
name=$(basename "$deb")
image="${GIT_WORKBENCH_SMOKE_IMAGE:-debian:trixie}"

(cd "$dir" && sha256sum "$name" > "$name.sha256")
echo "Checksum: $(cat "$dir/$name.sha256")"

# Docker's default seccomp/AppArmor profiles forbid user namespaces, which a stock Debian 13 desktop allows.
# Lifting them inside this throwaway container lets Chromium use its namespace sandbox as on a real install;
# the app is never run with --no-sandbox.
docker run --rm --network bridge --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  -v "$dir:/pkg:ro" -e DEB="$name" "$image" sh -euc '
  cd /pkg && sha256sum -c "$DEB.sha256"
  . /etc/os-release && echo "Container: $PRETTY_NAME $(uname -m)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends xvfb xauth ca-certificates >/dev/null
  apt-get install -y -qq --no-install-recommends "/pkg/$DEB" >/dev/null
  dpkg -s git-workbench | grep -E "^(Package|Status|Version|Architecture|Depends):"
  command -v git-workbench
  test -f /usr/share/applications/git-workbench.desktop && echo "Desktop entry installed."
  echo "chrome-sandbox mode: $(stat -c %a "/opt/Git Workbench/chrome-sandbox") (755 = user-namespace sandbox)"

  useradd -m tester
  su tester -c "git init -q -b main /home/tester/sample && cd /home/tester/sample \
    && git -c user.name=Smoke -c user.email=smoke@example.invalid commit -q --allow-empty -m \"installer smoke\" \
    && echo changed > untracked.txt"
  su tester -c "cd /home/tester && GIT_WORKBENCH_SMOKE=1 GIT_WORKBENCH_SMOKE_REPO=/home/tester/sample ELECTRON_DISABLE_GPU=1 \
    xvfb-run -a git-workbench --disable-gpu 2>/tmp/stderr.log" || { echo "Launch failed:"; tail -n 20 /tmp/stderr.log; exit 1; }

  apt-get purge -y -qq git-workbench >/dev/null
  if dpkg -s git-workbench >/dev/null 2>&1; then echo "Package still installed" >&2; exit 1; fi
  for leftover in "/opt/Git Workbench" /usr/bin/git-workbench /usr/share/applications/git-workbench.desktop; do
    if [ -e "$leftover" ]; then echo "Leftover after purge: $leftover" >&2; exit 1; fi
  done
  echo "Purged cleanly: package, /opt/Git Workbench, launcher and desktop entry removed."
'
