#!/bin/sh
# Static verification of the Windows x64 NSIS installer, runnable without Windows or wine.
#
# This does NOT perform a real install/launch/uninstall. electron-builder's NSIS
# template guards against a second instance via a Windows RPC/DCOM named-pipe check;
# Wine's incomplete RPC/DCOM support makes that check misfire ("BranchBrace is
# running" / stuck on a Retry loop that never clears), so a full silent install
# cannot be automated reliably in this environment. See docs/adr/0003-windows-installer.md
# for the wine diagnostic evidence (GUI wizard screens captured and inspected).
#
# Real install/launch/rebase/uninstall verification is manual, on a real Windows 11
# x64 machine: see docs/WINDOWS-INSTALL-CHECK.md.
set -eu

exe="${1:-}"
if [ -z "$exe" ]; then exe=$(ls artifacts/*.exe 2>/dev/null | head -n 1 || true); fi
if [ -z "$exe" ] || [ ! -f "$exe" ]; then
  echo "usage: $0 path/to/BranchBrace Setup <version>.exe" >&2
  exit 2
fi

echo "Checksum:"
sha256sum "$exe" | tee "$exe.sha256"

echo "PE header check:"
magic=$(head -c 2 "$exe" | od -An -tx1 | tr -d ' \n')
if [ "$magic" != "4d5a" ]; then
  echo "Not a valid PE (MZ) executable, got magic=$magic" >&2
  exit 1
fi
echo "MZ/PE header present (valid Windows executable)."

size=$(wc -c < "$exe")
echo "Size: $size bytes"
if [ "$size" -lt 10000000 ]; then
  echo "Installer unexpectedly small (<10MB): packaging likely failed" >&2
  exit 1
fi

echo "Static checks passed (checksum, PE header, size). This is not a substitute for the manual install/launch/uninstall check in docs/WINDOWS-INSTALL-CHECK.md."
