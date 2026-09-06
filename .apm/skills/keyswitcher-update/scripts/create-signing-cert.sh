#!/usr/bin/env bash
# Create a self-signed code-signing identity "keySwitcher Open Source" so App/build.sh
# signs reproducibly and the Accessibility grant survives rebuilds.
# The cert is intentionally untrusted (Gatekeeper rejects it) — codesign still signs with
# it, and a stable signature is all TCC needs to keep the grant. No trust step, no sudo.
set -euo pipefail
NAME="keySwitcher Open Source"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -p codesigning | grep -q "$NAME"; then
  echo "✓ identity already present: $NAME"
  exit 0
fi

PW="ksw-transient"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ksw-cert.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
KEY="$TMP/key.pem"; CRT="$TMP/cert.crt"; P12="$TMP/cert.p12"

openssl req -x509 -newkey rsa:2048 -nodes -keyout "$KEY" -out "$CRT" -days 3650 \
  -subj "/CN=$NAME" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning"

# macOS' importer needs the legacy PKCS#12 encoding with a SHA1 MAC; OpenSSL 3 defaults
# fail `security import` with "MAC verification failed". Empty passwords are flaky here too.
openssl pkcs12 -export -legacy -macalg sha1 \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES \
  -inkey "$KEY" -in "$CRT" -name "$NAME" -out "$P12" -passout pass:"$PW"

security import "$P12" -k "$KEYCHAIN" -P "$PW" -T /usr/bin/codesign -A

echo "--- verify ---"
security find-identity -p codesigning | grep "$NAME"
echo "✓ created. build.sh will now sign with \"$NAME\" instead of ad-hoc."
