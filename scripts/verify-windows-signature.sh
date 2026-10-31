#!/bin/sh
# Fail unless every given Windows binary carries an Authenticode signature, and, when
# WINDOWS_SIGNING_PUBLISHER is set, unless the signer certificate names that publisher.
# Runs inside the Wine build container after electron-builder (needs java + openssl).
# This checks presence and identity, not chain trust: Windows checks trust at install time.
set -eu

: "${JSIGN_JAR:?JSIGN_JAR must point to the jsign jar}"
[ "$#" -gt 0 ] || { echo "usage: $0 <file.exe>..." >&2; exit 2; }

for file in "$@"; do
  sig="$file.sig.pem"
  rm -f "$sig"
  if ! java -jar "$JSIGN_JAR" extract --format PEM "$file" >/dev/null 2>&1 || [ ! -s "$sig" ]; then
    echo "NOT SIGNED: $file" >&2
    exit 1
  fi
  # The PKCS#7 carries the whole chain; the publisher is the certificate whose CN matches.
  subjects=$(openssl pkcs7 -in "$sig" -print_certs -noout | sed -n 's/^subject=//p')
  rm -f "$sig"
  if [ -n "${WINDOWS_SIGNING_PUBLISHER:-}" ] \
    && ! printf '%s\n' "$subjects" | sed 's/$/,/' | grep -Fq "CN = $WINDOWS_SIGNING_PUBLISHER," ; then
    echo "WRONG PUBLISHER for $file (expected CN $WINDOWS_SIGNING_PUBLISHER):" >&2
    printf '%s\n' "$subjects" >&2
    exit 1
  fi
  echo "Signed: $file"
  printf '  %s\n' "$subjects"
done
