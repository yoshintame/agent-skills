# Persistent Accessibility across rebuilds

`App/build.sh` signs ad-hoc when no identity named `keySwitcher Open Source` exists. Ad-hoc means a different signature each build, so macOS drops the Accessibility grant on every reinstall. A stable self-signed identity fixes that: the signature stays constant and TCC keeps the grant.

The identity is intentionally **untrusted** (`CSSMERR_TP_NOT_TRUSTED` — Gatekeeper would reject it). That is fine here: `codesign` still signs with it, and only a stable signature is needed. No trust step, no `sudo`.

## Create it (scripted)

```sh
scripts/create-signing-cert.sh
```

Idempotent — skips if the identity already exists. It makes an RSA code-signing cert with `openssl`, exports a PKCS#12 in the legacy encoding macOS requires (`-legacy -macalg sha1 -keypbe/-certpbe PBE-SHA1-3DES`; OpenSSL 3 defaults fail `security import` with "MAC verification failed", and an empty p12 password is flaky), and imports it into the login keychain with `-T /usr/bin/codesign`. Touches the keychain, so run it with the sandbox off.

## Create it (Keychain Access GUI)

Keychain Access → **Certificate Assistant → Create a Certificate…**; name `keySwitcher Open Source`, Identity Type **Self Signed Root**, Certificate Type **Code Signing**.

## Verify

```sh
security find-identity -p codesigning | grep "keySwitcher Open Source"
```

Once present, `build-verify-install.sh` (via `build.sh`) signs with it instead of ad-hoc on every future build.

## Lock the installed app now (no rebuild)

To make an already-installed ad-hoc app cert-signed without rebuilding, re-sign it in place. Sparkle's nested code must be signed **inside-out** — `--deep` fails with `internal error in Code Signing subsystem` on `Sparkle.framework`:

```sh
ID="keySwitcher Open Source"; APP="/Applications/keySwitcher.app"
V="$APP/Contents/Frameworks/Sparkle.framework/Versions/B"
for t in "$V/XPCServices/Downloader.xpc" "$V/XPCServices/Installer.xpc" \
         "$V/Updater.app" "$V/Autoupdate" "$V" "$APP"; do
  codesign --force --sign "$ID" --timestamp=none "$t"
done
codesign --verify --deep --strict "$APP"
```

Writes to `/Applications` and reads the keychain key — run it with the sandbox off. The code identity changes once, so Accessibility is re-granted once on next launch, then the cert-based Designated Requirement (`certificate leaf = H"…"`) is stable across future rebuilds. An already-installed ad-hoc app otherwise keeps that signature until its next cert-signed rebuild.
