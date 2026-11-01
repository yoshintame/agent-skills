---
name: keyswitcher-update
description: Update the from-source KeySwitcher install.
---

# keyswitcher-update

KeySwitcher is a global key-event tap installed from source. Every release is untrusted until its diff is audited. Never build a tag you have not diffed, and never approve on your own — the user confirms the build.

The whole pipeline is desvio tasks in `~/.config/desvio/keyswitcher/`. Run every command outside the sandbox: they write `~/.local/share/desvio`, `~/.local/state/keyswitcher-update`, `/Applications`, and fetch upstream.

```bash
k() { desvio --config ~/.config/desvio/keyswitcher/desvio.conf "$@"; }
```

## Steps

1. **Check.** `k run check` prints `current`, `latest`, `newer`, then one line per patch branch that changed since the install: `branch-moved=<branch> <old>..<new>`, `branch-new=<branch>`, `branch-dropped=<branch>`. With `newer=false` and no branch lines, report up to date and stop. With only branch lines, skip to Local patches, then step 5 without the release `approve`.

2. **Diff.** `k run diff` (or `k run diff -- <tag>`) fetches tags into the build repo, blocks if the tag differs from upstream's, writes the diff, records the release as under audit, and prints `range`, `new_commit`, `diff`, the stat, then the lines matching red-flag patterns: `+ path:line: text` (line at the new tag), `- path:line: text` (line at the installed tag), `* path: binary, not scanned`. The hit list is a starting point, not the whole audit.

3. **Audit.** Read every added and removed line in context in the `diff` file, open every binary file the list marks, cite `file:line` at the new tag (a removed line at the installed tag, as listed), and classify clean / needs-review / block per `references/threat-model.md`.

4. **Report.** Give the user the verdict with evidence. If anything is block or needs-review, stop.

5. **Approve, build, install** — only on a clean verdict and the user's explicit go-ahead. A new host or `SUPublicEDKey` the user approved goes first into `ALLOWED_HOSTS_RE` / `EXPECTED_EDKEY` in `~/.config/desvio/keyswitcher/gates/verify.sh`, or the gate blocks it.

   ```bash
   k run approve        # the approval: writes audited-tag and audited-commit from the diff under audit
   k run approve -- --branch <branch>   # each manifest branch, after its review (Local patches)
   k build              # blocks unless the base is that tag at that commit, merges are plain and of reviewed branch tips, binary checks and --self-test pass
   k run install        # refuses a tree or bundle verify did not check; quits/relaunches the app, Sparkle auto-install off, pins what verify recorded
   ```

6. **Close out.** Move the baseline in `references/threat-model.md` to the new tag. Report the pin (`<tag> <head> <branch@oid> tree=<hash>`). If the build was ad-hoc signed (no `keySwitcher Open Source` identity — see `references/signing-cert.md`), Accessibility has to be re-granted once.

## Local patches

Our own fixes are the branches listed in `~/.config/desvio/keyswitcher/manifest.txt`, in the repo `~/Development/graninilya/keyswitcher`. desvio merges them into a throwaway `desvio` branch and never rewrites them. Conflict resolution is off (`DESVIO_AUTO_RESOLVE=0`) and the gate rejects any merge that differs from the automatic one, so a recorded rerere resolution cannot slip in. When a branch conflicts with a new tag: `k abort`, rebase that branch onto the tag, drop patches upstream already fixed, and build again.

Before every build, review each manifest branch against `references/threat-model.md` the same way as an upstream diff: `k run diff -- --branch <branch>` writes and lists `<audited-tag>...<branch>` (three dots — only the branch's own changes) in the same format (`+` at the branch tip, `-` at its merge base with the audited tag) and records the branch as under review. Report the verdict; only on a clean one and the user's go-ahead, `k run approve -- --branch <branch>` records `<branch> <commit> <audited-tag>` in `reviewed-branches`. The build blocks a merge of any branch tip without a review against its base, so a moved branch or a newly approved tag needs a fresh review.
