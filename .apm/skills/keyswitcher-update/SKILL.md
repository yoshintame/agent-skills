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

3. **Audit it.** Read `references/threat-model.md` — it holds the audited baseline and the per-category red flags. Read every added line in context, cite `file:line` at the new tag, and classify clean / needs-review / block. Treat as **block until explained**: a new outbound host or `URLSession`; a new SPM dependency; a changed `SUPublicEDKey` or `SUFeedURL`; tap `options` no longer `.listenOnly`; a removed or weakened secure-input guard; a new `Process`/`NSTask`/`dlopen`; a new `LaunchDaemon`/`LaunchAgent`; a new CI secret or network call under `.github/`.

4. **Report.** Give the user the verdict with evidence. If anything is block or needs-review, stop — do not build.

5. **Build, verify, install** — only on a clean verdict and the user's explicit go-ahead: `scripts/build-verify-install.sh <latest>`. It builds via the repo's `App/build.sh`, blocks if the tag differs from upstream's, if `otool -L` shows a non-system dylib other than Sparkle, on a baked-in host outside the allowlist or a changed `SUPublicEDKey`, and if the running app does not quit. It installs to `/Applications`, turns off Sparkle auto-install (`SUAutomaticallyUpdate`, so the author's binary cannot replace the audited build; update checks stay on), relaunches the app if it was running, and records the new pin. With local patches, install the rebased branch instead (below).

6. **Close out.** Report the new pinned tag and commit. If the build was ad-hoc signed (no `keySwitcher Open Source` identity — see `references/signing-cert.md`), Accessibility has to be re-granted once.

## Local patches

Our own fixes live on branch `local-fixes` in `~/Development/graninilya/keyswitcher`, on top of the audited upstream tag. The pin then carries a third field with the branch name, and steps 1–4 still audit upstream tag to tag.

Before every branch install, review `git diff <audited-tag>..local-fixes` against `references/threat-model.md` the same way as an upstream diff, including conflict resolutions after a rebase. The script prints those commits but does not judge them.

Install with `KSW_REPO=$HOME/Development/graninilya/keyswitcher scripts/build-verify-install.sh <audited-tag> local-fixes`. The audited tag is an explicit argument: the script blocks if it differs from upstream's tag or is not an ancestor of the branch, and warns when it moves the pinned base. It clones the repo, so only committed changes are built, and it blocks on a failing `--self-test` of the built bundle.

On a new upstream release, audit it first (steps 1–4), then `git fetch --tags` and `git rebase <latest> local-fixes` in the work repo, drop patches upstream already fixed, and install with `<latest>` as the audited tag. Rebasing onto an unaudited tag and installing would skip that release's audit.
