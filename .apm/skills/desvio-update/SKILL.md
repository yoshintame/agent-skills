---
name: desvio-update
description: Update every personal build that desvio carries.
---

# desvio-update

Each directory under `~/.config/desvio/` is one build. Update them one at a time by the rule below; a directory not in the table gets no build at all — ask the user how it updates and add it here.

| Config | How it updates |
|---|---|
| `plannotator` | `DESVIO_AUTO_RESOLVE=0 plannotator-update`. It rebuilds and installs only when the latest upstream tag, a manifest branch or the config changed; `--force` rebuilds anyway. The variable is not optional: the script inherits it from launchd, and a manual run without it lets Claude resolve conflicts. |
| `keyswitcher` | Invoke `/keyswitcher-update` and follow it. Never run `desvio build` or `desvio run install` for it outside that skill: its base is the audited tag, and only an audit plus the user's go-ahead moves it. |

Run desvio and the update scripts outside the sandbox: they write `~/.local/share/desvio`, fetch upstream, and install apps.

A merge conflict stops a build. Do not resolve it in the build tree. Report the build, branch and files, and on the user's word rebase that branch onto the new base in its own repo, so the resolution is a reviewable commit on the branch.

"A merge is in progress at <build tree>" with no unmerged paths is an earlier run killed mid-merge (launchd runs these daily, so it can sit for weeks). `desvio --config ~/.config/desvio/<config>/desvio.conf abort` discards it — the build tree is throwaway — then rerun.

When the gate fails, check whether the failing file is in a manifest branch (`git diff --stat $(git merge-base <base> <branch>)..<branch>` in `DESVIO_REPO`). An error only in upstream's files means the release itself fails the gate: report it with the error line and leave the install as is. Do not loosen the gate or pin an older tag without the user.

Finish with one line per build: `<config>: <old tag/head> → <new>`, `up to date`, or what stopped it.
