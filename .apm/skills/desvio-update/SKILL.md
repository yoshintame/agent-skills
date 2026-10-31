---
name: desvio-update
description: Update every personal build that desvio carries.
---

# desvio-update

Each directory under `~/.config/desvio/` is one build. Update them one at a time by the rule below; a directory not in the table gets no build at all — ask the user how it updates and add it here.

| Config | How it updates |
|---|---|
| `plannotator` | `plannotator-update`. It rebuilds and installs only when the latest upstream tag, a manifest branch or the config changed; `--force` rebuilds anyway; a silent exit 0 means up to date. Take `plannotator --version` before and after for the report. |
| `keyswitcher` | Invoke `/keyswitcher-update` and follow it. Never run `desvio build` or `desvio run install` for it outside that skill: its base is the audited tag, and only an audit plus the user's go-ahead moves it. |

Run desvio and the update scripts outside the sandbox: they write `~/.local/share/desvio`, fetch upstream, and install apps.

Both configs set `DESVIO_AUTO_RESOLVE=0`, so a new merge conflict stops the build; a resolution recorded by an earlier rerere run still replays silently. Do not resolve a conflict in the build tree. Report the build, branch and files, and on the user's word run `desvio --config ~/.config/desvio/<config>/desvio.conf abort`, rebase that branch onto the new base in its own repo — the resolution becomes a reviewable commit on the branch — and rebuild.

"A merge is in progress at <build tree>" with no unmerged paths is an earlier run killed mid-merge (`plannotator-update` runs daily from launchd, so it can sit for weeks). `desvio --config ~/.config/desvio/<config>/desvio.conf abort` discards it — the build tree is throwaway — then rerun.

When the gate fails, find the culprit with `desvio --config ~/.config/desvio/<config>/desvio.conf build --bisect-gate`. If no manifest branch broke it, the release itself fails the gate: report it with the error line and leave the install as is. Do not loosen the gate or pin an older tag without the user.

Finish with one line per build: `<config>: <old version/tag> → <new>`, `up to date`, or what stopped it.
