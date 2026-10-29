---
name: git-review
description: Open a commit set or range for review in Plannotator.
---

# /git-review

## Target

| Input | Pass to `open` |
|---|---|
| no arguments | `--session current` — commits this Claude Code session made on HEAD of `<repo>` |
| `N` | `N` (`HEAD~N..HEAD`) |
| two refs `<a> <b>` | `<a>...<b>` |
| branch / "this feature" | `<master-or-main>...<branch>` |
| explicit commit list | the SHAs, in any order |

`--session current` fails under Codex, or when a commit's subject is absent from the command that made it (message from `-F`). Then pass the SHAs of the commits you made, taken from your own context.

## Open

Run outside the sandbox (it writes `~/.cache/git-review`, `~/.plannotator` and binds a loopback port). Always pass `-C`: cwd drifts between Bash calls.

```bash
bun <skill-dir>/scripts/git-review.ts open -C <repo> <target>
```

Output lines: `url:`, `review:` (review dir), `range:`, `stat:`, then `commit:` per commit or `source:` for a range. `reused: true` means a live server for the same target was returned as is.

`interleaved: <file> (foreign: <shas>)` — a foreign commit changed that file between two of the set's commits, so its diff carries the foreign change too. Tell the user which file; for a clean view open each set commit touching it on its own.

Then:

1. `mcp__paseo__browser_new_tab` with the `url`. Without Paseo tools, give the URL as a markdown link.
2. Start `bun <skill-dir>/scripts/git-review.ts wait <review>` with `run_in_background`, outside the sandbox. It blocks until the user submits, prints the decision and removes the clone.
3. Reply with one line: what is under review (`commit:` lines or the range) and the `stat:`.

## Feedback

`wait` prints `decision: approved | annotated | dismissed` and Plannotator's message. `annotated` — the message is the user's review: act on it in the real repo. `dismissed` — closed without feedback, do nothing.

`wait` exiting 1 with "without a decision" means the server died; the clone is kept, and re-running the same `open` reuses its path, so drafts survive.

## Notes

- One-shot server: after Close or Approve the tab is dead. Another pass needs a new `open`.
- "Open in editor" in Plannotator opens the clone under `~/.cache/git-review`; edits there are lost. Edit the real repo.
- To abandon a review without a decision: `git-review.ts close <review>`. Reviews older than 7 days are killed and removed on the next `open`.
- The server is killed 30 minutes after `open`; `wait` then exits 1 with "review expired". Re-run the same `open` to continue.
- `open` fails fast when `plannotator` is not on `PATH`.
