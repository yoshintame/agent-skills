---
name: keyswitcher-update
description: Update the from-source KeySwitcher install.
---

# keyswitcher-update

KeySwitcher is a global key-event tap installed from source. Every release is untrusted until its diff is audited. Never build a tag you have not diffed, and never approve on your own — the user confirms the build.

Run the scripts from this skill's directory. Run `desvio`, the writes under `~/.local/state/keyswitcher-update` and `scripts/create-signing-cert.sh` outside the sandbox: they write `~/.local/share/desvio`, `~/.local/state`, `/Applications` and the keychain, and the build fetches Sparkle through SPM.

## Steps

1. **Check for an update.** `scripts/check-update.sh` prints `current`, `latest`, `newer`, then one line per patch branch that changed since the install: `branch-moved=<branch> <old>..<new>`, `branch-new=<branch>`, `branch-dropped=<branch>`. With `newer=false` and no branch lines, report up to date and stop. With only branch lines, skip steps 2–4: review those branches (Local patches), report, and on the user's go-ahead run step 5 without touching the audit files.

2. **Get the diff.** `scripts/prepare-diff.sh <latest>` writes the diff, prints `new_commit=<sha>` and a red-flag hit list. That list is a starting point, not the whole audit.

3. **Audit it.** Read every added and removed line in context, cite `file:line` at the new tag, and classify clean / needs-review / block per `references/threat-model.md`.

4. **Report.** Give the user the verdict with evidence. If anything is block or needs-review, stop — do not build.

5. **Build, verify, install** — only on a clean verdict and the user's explicit go-ahead. A new host or `SUPublicEDKey` the user approved goes first into `ALLOWED_HOSTS_RE` / `EXPECTED_EDKEY` in `~/.config/desvio/keyswitcher/verify.sh`, or the gate blocks it. The build runs through desvio with the config in `~/.config/desvio/keyswitcher/`:

   ```bash
   printf '%s\n' <latest> > ~/.local/state/keyswitcher-update/audited-tag
   printf '%s\n' <new_commit> > ~/.local/state/keyswitcher-update/audited-commit
   desvio --config ~/.config/desvio/keyswitcher/desvio.conf build
   desvio --config ~/.config/desvio/keyswitcher/desvio.conf run install
   ```

   Writing the two audit files is the approval; nothing else may write them. `build` merges the manifest branches onto the tag and blocks if the base is not the audited tag, if the tag's commit differs from `audited-commit` or from upstream's, if a merge is anything but the plain automatic merge, on a non-system dylib other than Sparkle, a baked-in host outside the allowlist, a changed `SUPublicEDKey`, or a failing `--self-test`. `run install` refuses a build tree that did not pass that gate, quits and relaunches the app, turns off Sparkle auto-install (the author's binary cannot replace the audited build; update checks stay on), and records the pin `<tag> <head> <branch@oid> tree=<hash>`.

6. **Close out.** Move the baseline in `references/threat-model.md` and the fallback tag in `scripts/prepare-diff.sh` to the new tag. Report the new pin. If the build was ad-hoc signed (no `keySwitcher Open Source` identity — see `references/signing-cert.md`), Accessibility has to be re-granted once.

## Local patches

Our own fixes are the branches listed in `~/.config/desvio/keyswitcher/manifest.txt`, in the repo `~/Development/graninilya/keyswitcher`. desvio merges them into a throwaway `desvio` branch and never rewrites them. Conflict resolution is off (`DESVIO_AUTO_RESOLVE=0`) and the gate rejects any merge that differs from the automatic one, so a recorded rerere resolution cannot slip in. When a branch conflicts with a new tag: `desvio --config ~/.config/desvio/keyswitcher/desvio.conf abort`, rebase that branch onto the tag, drop patches upstream already fixed, and build again.

Before every install, review each manifest branch against `references/threat-model.md` the same way as an upstream diff: `git -C ~/Development/graninilya/keyswitcher diff <audited-tag>...<branch>` (three dots — only the branch's own changes). The build prints those commits but does not judge them.
