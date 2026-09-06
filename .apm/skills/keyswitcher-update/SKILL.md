---
name: keyswitcher-update
description: Update the from-source KeySwitcher install (graninilya/keyswitcher) by auditing the new release diff before rebuilding.
---

# keyswitcher-update

KeySwitcher is a global key-event tap installed from source. Every release is untrusted until its diff is audited. Never build a tag you have not diffed, and never approve on your own — the user confirms the build.

Run the scripts from this skill's directory. Builds need network (SPM fetches Sparkle) and a Swift toolchain; if a build dies on `Operation not permitted` writing `xcrun_db`, that is the sandbox — rerun the build step with the sandbox off.

## Steps

1. **Check for an update.** `scripts/check-update.sh` prints `current`, `latest`, `newer`. If `newer=false`, report up-to-date and stop.

2. **Get the diff.** `scripts/prepare-diff.sh <latest>` writes the diff and prints a red-flag hit list. That list is a starting point, not the whole audit.

3. **Audit it.** Read `references/threat-model.md` — it holds the audited v0.2.6 baseline and the per-category red flags. Read every added line in context, cite `file:line` at the new tag, and classify clean / needs-review / block. Treat as **block until explained**: a new outbound host or `URLSession`; a new SPM dependency; a changed `SUPublicEDKey` or `SUFeedURL`; tap `options` no longer `.listenOnly`; a removed `IsSecureEventInputEnabled()` guard; a new `Process`/`NSTask`/`dlopen`; a new `LaunchDaemon`/`LaunchAgent`; a new CI secret or network call under `.github/`.

4. **Report.** Give the user the verdict with evidence. If anything is block or needs-review, stop — do not build.

5. **Build, verify, install** — only on a clean verdict and the user's explicit go-ahead: `scripts/build-verify-install.sh <latest>`. It builds via the repo's `App/build.sh`, blocks if `otool -L` shows a non-system dylib other than Sparkle, blocks on a baked-in host outside the allowlist or a changed `SUPublicEDKey`, installs to `/Applications`, and records the new pin.

6. **Close out.** Report the new pinned tag and commit. If the build was ad-hoc signed (no `keySwitcher Open Source` identity — see `references/signing-cert.md`), Accessibility has to be re-granted once.
