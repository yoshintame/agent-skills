---
name: maintenance-cleanup
description: Diagnose and free disk space on this Mac. Use when disk is low or the user asks to clean up / free space.
---

# maintenance-cleanup

Free disk space on this Mac (`lasthaze-mbp`, fish + gtrash). Two defaults are wrong here:

- **`df /` lies.** The boot volume is a sealed ~11G snapshot. Real free space lives on the Data volume: `df -h /System/Volumes/Data`.
- **`rm` is aliased to `gtrash put`.** Plain `rm -rf` *moves* files into `~/.local/share/Trash` on the same volume and frees nothing. To actually delete, bypass the alias with `command rm -rf <path>`, or empty the trash with `gtrash prune --day 0 -f`.

## Scan

```
bun ~/.claude/skills/maintenance-cleanup/scripts/scan.ts
```

Prints real free space plus the size of each known hotspot, tagged `SAFE` (caches, trash — delete freely) or `ASK` (VM disks, games, media — confirm first).

## Clean

There are two trashes; empty both:

- gtrash: `gtrash summary`, then `gtrash prune --day 0 -f`
- macOS: `command rm -rf ~/.Trash/*` — leftover "Permission denied" items clear via Finder -> Empty Trash

Caches regenerate on their own — delete without asking:

```
brew cleanup -s
command rm -rf ~/.npm/_cacache ~/.cache/{huggingface,uv,pnpm,nix,puppeteer,act,bun,.bun}
command rm -rf ~/Library/Caches/{Homebrew,restic,ms-playwright,Cypress,com.spotify.client}
nix-collect-garbage -d
```

Delete the listed `~/.cache` subdirs, not the whole dir. Session transcripts live in `~/.claude/projects/` (not a cache — never touched by cleanup); `~/.cache/claude-history` is only a rebuildable search index of them, despite the name.

`~/.cache` holds dot-prefixed subdirs that `*` does not match — `~/.cache/.bun` is a real hotspot (17G on one pass) and is distinct from `~/.cache/bun`. When breaking the dir down, glob both or the biggest item stays invisible:

```
du -sh ~/.cache/.[!.]* ~/.cache/* | sort -rh | head -20
```

Confirm before touching the `ASK` rows:

- **OrbStack** is the active container runtime — never delete its disk; shrink it with `docker system prune -a --volumes`.
- **Docker Desktop** (`~/Library/Containers/com.docker.docker`) is stale — remove `Data/vms` only after confirming the move to OrbStack.
- **Telegram** cache: clear from the app's GUI, not by deleting its Group Container (that holds the session).
- Steam, `~/Movies`, large `~/Downloads`: the user's data, ask.

The `rm`/`brew`/`gtrash` deletions target paths outside the sandbox write-allowlist, so run them with the sandbox disabled.
