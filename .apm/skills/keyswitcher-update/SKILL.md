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

5. **Build, verify, install** — only on a clean verdict and the user's explicit go-ahead. The build runs through desvio with the config in `~/.config/desvio/keyswitcher/` (dotfiles module `keyswitcher`):

   ```bash
   printf '%s\n' <latest> > ~/.local/state/keyswitcher-update/audited-tag
   desvio --config ~/.config/desvio/keyswitcher/desvio.conf build
   desvio --config ~/.config/desvio/keyswitcher/desvio.conf run install
   ```

   Writing `audited-tag` is the approval; nothing else may write it. `build` merges the manifest branches onto that tag and blocks if the base is not the audited tag or differs from upstream's tag, if a merge is anything but the plain automatic merge, on a non-system dylib other than Sparkle, a baked-in host outside the allowlist, a changed `SUPublicEDKey`, or a failing `--self-test`. `run install` refuses a build tree that did not pass that gate, quits and relaunches the app, turns off Sparkle auto-install (the author's binary cannot replace the audited build; update checks stay on), and records the pin `<tag> <head> <branch@oid> tree=<hash>`.

6. **Close out.** Report the new pinned tag and commit. If the build was ad-hoc signed (no `keySwitcher Open Source` identity — see `references/signing-cert.md`), Accessibility has to be re-granted once.

## Local patches

Our own fixes are branches listed in the config's `manifest.txt` (now `local-fixes` in `~/Development/graninilya/keyswitcher`). desvio merges them into a throwaway `desvio` branch and never rewrites them. Conflict resolution is off (`DESVIO_AUTO_RESOLVE=0`) and the gate rejects any merge that differs from the automatic one, so a recorded rerere resolution cannot slip in: when a branch conflicts with a new tag, rebase that branch onto the tag, drop patches upstream already fixed, and build again.

Before every install, review `git diff <audited-tag>..<branch>` for each manifest branch against `references/threat-model.md` the same way as an upstream diff. The build prints those commits but does not judge them.
