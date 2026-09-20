#!/usr/bin/env python3
"""Batch decomposer for the friction miner.

Reuses the compound-command normalizer from smart_approve.py (the PreToolUse
hook) instead of reinventing it: split on &&/||/;/|/newlines, strip env
prefixes / redirections / sudo|env|command wrappers / shell keywords, drop
standalone assignments and structural headers (for/while/if...).

Reads a JSON array of command strings on stdin, writes a JSON array of
{"leader": <family>, "families": [<family>...]} aligned by index on stdout.
The leader is the first non-trivial sub-command (echo/cd/export/print/...
wrappers skipped) — the real culprit, not the wrapper prefix.
"""
import json
import os
import re
import sys

for _h in (
    "~/.claude/hooks",
    "~/.dotfiles/modules/home/agents-shared/config/hooks",
):
    _p = os.path.expanduser(_h)
    if os.path.exists(os.path.join(_p, "smart_approve.py")):
        sys.path.insert(0, _p)
        break

from smart_approve import decompose_command  # noqa: E402

# Wrapper / trivial commands that never identify friction — the measurement
# note flagged echo/cd/export/for as noise that hides the real culprit.
WRAP = frozenset({
    "echo", "cd", "export", "printf", "print", "true", "false", ":",
    "set", "pwd", "sleep", "source", ".", "unset", "umask", "wait",
    "shift", "eval", "exec", "time", "nohup", "exit", "return", "read",
})


# Tools whose first argument is a subcommand worth keeping in the family key
# (git status, docker exec, gh api). For everything else the first arg is data
# (ssh HOST, curl URL) and appending it just fragments the rollup.
SUBCMD_TOOLS = frozenset({
    "git", "gh", "glab", "docker", "docker-compose", "kubectl", "helm",
    "npm", "pnpm", "yarn", "bun", "bunx", "npx", "cargo", "go", "mise",
    "brew", "uv", "pip", "pip3", "poetry", "systemctl", "launchctl",
    "apt", "apt-get", "search-github", "search-reddit", "aws", "gcloud",
    "az", "terraform", "make", "just", "task", "rye", "deno", "flutter",
    "rustup", "nix", "nix-env", "gem", "bundle", "composer", "dotnet",
})


def family(subcmd):
    """basename(argv0) [+ subcommand token] — 'docker exec', 'gh api'."""
    toks = subcmd.split()
    if not toks:
        return ""
    head = re.sub(r"^.*/", "", toks[0])
    if (head in SUBCMD_TOOLS and len(toks) > 1
            and re.fullmatch(r"[a-z][a-z0-9-]+", toks[1])):
        return f"{head} {toks[1]}"
    return head


def analyze(command):
    subs = decompose_command(command or "")
    fams, leader = [], None
    for s in subs:
        f = family(s)
        if not f:
            continue
        fams.append(f)
        if leader is None and f.split()[0] not in WRAP:
            leader = f
    if leader is None:
        leader = fams[0] if fams else (family(command or "") or "?")
    return {"leader": leader, "families": fams}


def main():
    cmds = json.load(sys.stdin)
    json.dump([analyze(c) for c in cmds], sys.stdout)


if __name__ == "__main__":
    main()
