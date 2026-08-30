#!/usr/bin/env python3
"""
Claude Code Permission Analyzer

Analyzes permission request logs and optimizes the allow list.
Cleans up hardcoded one-off entries and adds missing safe patterns.

Usage:
  analyze-permissions.py              Show analysis report
  analyze-permissions.py --apply      Apply changes and mark log as processed
"""

import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

# --- Paths ---
CLAUDE_DIR = Path.home() / ".claude"
SETTINGS_PATH = Path.home() / ".dotfiles" / "modules" / "claude" / "config" / "settings.json"
SETTINGS_LOCAL_PATH = CLAUDE_DIR / "settings.local.json"
LOG_PATH = CLAUDE_DIR / "permission-requests.jsonl"
MARKER_PATH = CLAUDE_DIR / "permission-requests-processed.json"

# --- Classification rules ---

# Tools that are always safe — core Claude Code functionality
# NOTE: Edit and Write are NOT here — they need path-based restrictions
ALWAYS_SAFE_TOOLS = {
    "Glob",          # file listing by pattern (read-only)
    "Grep",          # content search (read-only)
    "TodoWrite",     # task management (internal)
    "NotebookEdit",  # notebook editing
}

# Bash commands safe enough for auto-allow
SAFE_BASH_COMMANDS = {
    "mkdir", "cp", "mv", "ln", "chmod", "chown",
    "open", "pbcopy", "pbpaste",
    "test", "[", "true", "false",
    "type", "command", "hash",
    "nix-shell", "nix-env", "nix",
    "time", "timeout",
}

# Patterns that are genuinely dangerous — never auto-allow
DANGEROUS_PATTERNS = [
    r"rm\s+-r[f ]?\s+/(?!tmp)",   # rm -rf with absolute path (except /tmp)
    r"rm\s+-r[f ]?\s+\.\.",       # rm -rf parent
    r"git\s+push\s+--force",
    r"git\s+push\s+-f\b",
    r"git\s+reset\s+--hard",
    r"git\s+clean\s+-f",
    r"git\s+checkout\s+\.\s*$",   # git checkout . (discard all)
    r"sudo\s+rm",
    r"DROP\s+(TABLE|DATABASE)",
    r"DELETE\s+FROM",
    r"TRUNCATE\s+",
    r"mkfs\.",
    r"\bdd\s+if=",
    r">\s*/dev/sd",
    r"^curl\s",              # exfiltration vector
    r"&&\s*curl\s",          # curl in compound command
    r";\s*curl\s",           # curl after semicolon
    r"\|\s*curl\s",          # pipe to curl
    r"^ssh\s",               # remote access
    r"^xargs\s",             # arbitrary command execution
]


def load_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    return json.loads(path.read_text())


def save_json(path: Path, data: dict):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def load_log() -> list[dict]:
    if not LOG_PATH.exists():
        return []
    entries = []
    for line in LOG_PATH.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def load_marker() -> int:
    data = load_json(MARKER_PATH)
    return data.get("processed_count", 0) if data else 0


def save_marker(count: int):
    save_json(MARKER_PATH, {
        "processed_count": count,
        "last_run": datetime.now(timezone.utc).isoformat(),
    })


# --- Allow list analysis ---

def parse_rule(rule: str) -> tuple[str, str | None]:
    """Parse 'Tool(arg)' into (tool, arg). Returns (tool, None) if no arg."""
    m = re.match(r"^(\w+)\((.+)\)$", rule, re.DOTALL)
    if m:
        return m.group(1), m.group(2)
    return rule, None


def glob_to_regex(pattern: str) -> str:
    """Convert simple glob to regex. Handles * and **."""
    result = ""
    i = 0
    while i < len(pattern):
        c = pattern[i]
        if c == "*":
            if i + 1 < len(pattern) and pattern[i + 1] == "*":
                result += ".*"
                i += 2
                if i < len(pattern) and pattern[i] == "/":
                    result += "/?"
                    i += 1
                continue
            else:
                result += "[^/]*"
        elif c in r"\.^$+{}[]|()":
            result += "\\" + c
        else:
            result += re.escape(c) if c in "?:" else c
        i += 1
    return result


def is_covered_by(specific: str, broad: str) -> bool:
    """Check if 'specific' rule is already covered by 'broad' rule."""
    if specific == broad:
        return False

    s_tool, s_arg = parse_rule(specific)
    b_tool, b_arg = parse_rule(broad)

    if s_tool != b_tool:
        return False

    # Broad allows everything for this tool
    if b_arg is None and s_arg is not None:
        return True

    if s_arg is None or b_arg is None:
        return False

    # Try glob matching
    try:
        b_regex = glob_to_regex(b_arg)
        if re.fullmatch(b_regex, s_arg):
            return True
    except re.error:
        pass

    return False


# Tools where path-specific rules are intentional security restrictions.
# Don't flag path-specific entries as redundant even if a bare rule exists.
# Instead, flag the BARE rule as the problem.
PATH_RESTRICTED_TOOLS = {"Edit", "Read"}


def find_redundant(allow_list: list[str]) -> list[tuple[str, str]]:
    """Find entries covered by broader patterns in the same list."""
    redundant = []
    for entry in allow_list:
        tool, arg = parse_rule(entry)

        # Path-specific Edit/Read rule: still redundant if a BROADER path rule
        # of the same tool covers it (e.g. a deep worktree path under a
        # `.../worktrees/**` rule). It is NOT redundant just because a bare
        # rule exists — there the bare rule is the problem, flagged below.
        if tool in PATH_RESTRICTED_TOOLS and arg is not None:
            for other in allow_list:
                o_tool, o_arg = parse_rule(other)
                if o_arg is None:
                    continue  # bare rule — does not count as "covering"
                if is_covered_by(entry, other):
                    redundant.append((entry, f"covered by: {other}"))
                    break
            continue

        # If this is a bare Edit/Read and path-specific rules exist,
        # flag the bare rule as the problem
        if tool in PATH_RESTRICTED_TOOLS and arg is None:
            has_paths = any(
                parse_rule(other)[0] == tool and parse_rule(other)[1] is not None
                for other in allow_list
            )
            if has_paths:
                redundant.append((entry, "SECURITY: bare rule overrides path restrictions — remove it"))
            continue

        for other in allow_list:
            if is_covered_by(entry, other):
                redundant.append((entry, f"covered by: {other}"))
                break
    return redundant


def _strip_quoted(s: str) -> str:
    """Remove single/double-quoted spans so shell operators inside quotes
    (e.g. regex alternation `a|b`) aren't mistaken for command separators."""
    out = []
    quote = None
    for c in s:
        if quote:
            if c == quote:
                quote = None
        elif c in ("'", '"'):
            quote = c
        else:
            out.append(c)
    return "".join(out)


def is_compound_command(arg: str) -> bool:
    """True if arg chains multiple shell statements (`;`, `|`, `&&`, `||`).

    Such an entry is a session-captured one-off: the whole pipeline must
    match verbatim, so it is never reusable in a curated allow list.
    """
    return bool(re.search(r"[;|]|&&", _strip_quoted(arg)))


def find_hardcoded(allow_list: list[str]) -> list[tuple[str, str]]:
    """Find one-off hardcoded entries that shouldn't be in a curated list."""
    hardcoded = []
    for entry in allow_list:
        tool, arg = parse_rule(entry)
        if arg is None:
            continue

        if tool == "Bash":
            # Compound pipelines: chained statements captured verbatim from a
            # session — never match again, regardless of which paths they use.
            # The `*` guard uses quote-stripped text so glob chars inside
            # quoted args (e.g. find -path "*x*") aren't mistaken for a
            # permission wildcard.
            if "*" not in _strip_quoted(arg) and is_compound_command(arg):
                hardcoded.append((entry, "one-off compound command"))
                continue
            # Specific absolute home paths — machine/project-specific, they
            # do not belong in a curated cross-project list. A trailing
            # permission wildcard does not make the baked-in path reusable.
            if ("/Users/" in arg or "~/" in arg) and len(arg) > 60:
                hardcoded.append((entry, "hardcoded absolute path"))
                continue
            # Pinned URL or network endpoint — a literal http(s) URL or IP
            # address targets one specific resource and never recurs. The
            # __TRACKED_VAR__ placeholder marks an intentionally templated URL.
            if "__TRACKED_VAR__" not in arg and (
                re.search(r"https?://", arg)
                or re.search(r"\b\d{1,3}(?:\.\d{1,3}){3}\b", arg)
            ):
                hardcoded.append((entry, "pinned URL / network endpoint"))
                continue
            # Specific test commands
            if re.search(r"vitest run .+\.test\.ts$", arg):
                hardcoded.append((entry, "specific test file"))
                continue
            # Specific ssh/docker commands without wildcards
            if (arg.startswith("ssh ") or arg.startswith("docker exec ")) and "*" not in arg:
                hardcoded.append((entry, "specific remote command"))
                continue
            # Very long escaped python commands
            if "import sys,json" in arg and len(arg) > 80:
                hardcoded.append((entry, "specific python oneliner"))
                continue

        if tool == "Read":
            # Check if already covered by Read(/**)
            if "Read(/**)" in allow_list and entry != "Read(/**)":
                hardcoded.append((entry, "already covered by Read(/**)"))
                continue
            # Ephemeral macOS temp dirs — the random folder name is long gone
            if "/var/folders/" in arg:
                hardcoded.append((entry, "ephemeral temp-dir path"))
                continue

    return hardcoded


def find_stale_directories(dirs: list[str]) -> list[tuple[str, str]]:
    """Find additionalDirectories entries that are dead or redundant.

    An entry is stale when the directory no longer exists on disk, or when
    it sits under another *existing* listed directory that already grants
    access to the whole subtree. A dead parent is not treated as covering —
    it will be removed itself, so its children must stand on their own.
    """
    stale = []
    existing = {d for d in dirs if Path(d).is_dir()}
    for d in dirs:
        if d not in existing:
            stale.append((d, "directory does not exist"))
            continue
        parent = next(
            (p for p in dirs
             if p != d and p in existing and d.startswith(p.rstrip("/") + "/")),
            None,
        )
        if parent:
            stale.append((d, f"nested under {parent}"))
    return stale


# --- allow-list ordering ---

def allow_group(entry: str) -> int:
    """Tool group index for an allow entry. Defines display order and the
    blank-line separators written into settings.json."""
    if entry.startswith("mcp__"):  return 6
    if "(" not in entry:           return 0  # bare tools: Grep, WebSearch, WebFetch
    if entry.startswith("Read("):  return 1
    if entry.startswith("Edit("):  return 2
    if entry.startswith("Write("): return 3
    if entry.startswith("Bash("):  return 4
    if entry.startswith("Skill("): return 5
    return 7


def sort_allow_list(allow: list[str]) -> list[str]:
    """Deduplicate and sort the allow list by tool group, then alphabetically
    (case-insensitive) within each group."""
    return sorted(set(allow), key=lambda e: (allow_group(e), e.lower()))


def dump_settings(data: dict) -> str:
    """Serialize settings.json with a blank line between allow-list tool
    groups. Blank lines are valid JSON whitespace; they make the curated
    list readable and are re-established on every run."""
    text = json.dumps(data, indent=2, ensure_ascii=False)
    out: list[str] = []
    in_allow = False
    prev_group: int | None = None
    for line in text.split("\n"):
        stripped = line.strip()
        if not in_allow:
            out.append(line)
            if stripped == '"allow": [':
                in_allow, prev_group = True, None
            continue
        if stripped in ("]", "],"):
            in_allow = False
            out.append(line)
            continue
        value = stripped[:-1] if stripped.endswith(",") else stripped
        try:
            group = allow_group(json.loads(value))
        except (json.JSONDecodeError, TypeError):
            group = prev_group
        if prev_group is not None and group != prev_group:
            out.append("")
        out.append(line)
        prev_group = group
    return "\n".join(out) + "\n"


# Commands that should never be generalized to wildcard
NEVER_GENERALIZE = {
    "rm", "rmdir", "ssh", "sudo", "kill", "killall",
    "dd", "mkfs", "mount", "umount", "shutdown", "reboot",
    "curl", "xargs", "tee", "cd",
}


def extract_generalizations(
    hardcoded: list[tuple[str, str]], existing: set[str]
) -> tuple[list[str], list[str]]:
    """
    Derive general patterns from hardcoded entries.
    Returns (safe_patterns, review_patterns).
    """
    safe = []
    review = []
    seen = set()

    for entry, _reason in hardcoded:
        tool, arg = parse_rule(entry)
        if tool != "Bash" or not arg:
            continue

        # Strip env var prefixes (FOO=bar cmd ...)
        parts = arg.split()
        cmd = None
        for p in parts:
            if "=" not in p and not p.startswith("-"):
                cmd = p
                break

        if not cmd:
            continue

        pattern = f"Bash({cmd} *)"
        if pattern in existing or pattern in seen:
            continue
        seen.add(pattern)

        if cmd in NEVER_GENERALIZE:
            review.append(pattern)
        elif cmd in SAFE_BASH_COMMANDS:
            safe.append(pattern)
        else:
            review.append(pattern)

    return safe, review


# --- Permission log analysis ---

def classify_entry(tool: str, tool_input: dict) -> tuple[str, str | None]:
    """
    Classify a permission request.
    Returns (category, suggested_rule).
    category: "safe" | "review" | "dangerous"
    """
    if tool in ALWAYS_SAFE_TOOLS:
        return "safe", tool

    if tool == "Bash":
        cmd = tool_input.get("command", "")

        # Dangerous first
        for pattern in DANGEROUS_PATTERNS:
            if re.search(pattern, cmd, re.IGNORECASE):
                return "dangerous", None

        # Extract base command (skip env var prefixes)
        parts = cmd.strip().split()
        base = None
        for p in parts:
            if "=" not in p and not p.startswith("-"):
                base = p
                break

        if base in SAFE_BASH_COMMANDS:
            return "safe", f"Bash({base} *)"

        # git subcommands — some safe, some review
        if base == "git" and len(parts) > 1:
            idx = parts.index("git") if "git" in parts else 0
            sub = parts[idx + 1] if idx + 1 < len(parts) else ""
            if sub.startswith("-"):
                # git -C ... subcmd
                for p in parts[idx + 1 :]:
                    if not p.startswith("-") and p != parts[idx + 1]:
                        sub = p
                        break
            safe_git = {"commit", "add", "stash", "switch", "restore"}
            review_git = {"push", "merge", "rebase", "cherry-pick", "reset"}
            if sub in safe_git:
                return "safe", f"Bash(git {sub} *)"
            if sub in review_git:
                return "review", f"Bash(git {sub} *)"

        if base:
            return "review", f"Bash({base} *)"
        return "review", None

    if tool == "WebFetch":
        url = tool_input.get("url", "")
        m = re.search(r"https?://([^/]+)", url)
        if m:
            return "review", f"WebFetch(domain:{m.group(1)})"
        return "review", None

    if tool.startswith("mcp__"):
        return "review", tool

    if tool == "Skill":
        skill = tool_input.get("skill", "")
        return "safe", f"Skill({skill})"

    return "review", tool


# --- Reporting ---

def print_section(title: str):
    print(f"\n{'─' * 60}")
    print(f"  {title}")
    print(f"{'─' * 60}")


def report_cleanup(allow_list: list[str]):
    print_section("PHASE 1: Allow list cleanup")

    redundant = find_redundant(allow_list)
    hardcoded = find_hardcoded(allow_list)

    if redundant:
        print(f"\n  Redundant entries ({len(redundant)}):")
        for entry, reason in redundant:
            print(f"    ✗ {entry}")
            print(f"      → {reason}")
    else:
        print("\n  No redundant entries found.")

    if hardcoded:
        print(f"\n  Hardcoded one-off entries ({len(hardcoded)}):")
        for entry, reason in hardcoded:
            print(f"    ✗ {entry}")
            print(f"      → {reason}")

        existing = set(allow_list)
        safe_gen, review_gen = extract_generalizations(hardcoded, existing)
        if safe_gen:
            print(f"\n  Safe generalizations (will auto-add with --apply):")
            for g in safe_gen:
                print(f"    + {g}")
        if review_gen:
            print(f"\n  Review generalizations (NOT auto-added, decide manually):")
            for g in review_gen:
                print(f"    ? {g}")
    else:
        print("\n  No hardcoded entries found.")

    if allow_list != sort_allow_list(allow_list):
        print("\n  Allow list is not grouped/sorted — --apply will reorder it.")

    return redundant, hardcoded


def report_log(allow_list: list[str]):
    print_section("PHASE 2: Permission log analysis")

    entries = load_log()
    processed = load_marker()

    if not entries:
        print(f"\n  No log file found at {LOG_PATH}")
        print("  Hook is configured — data will appear after next permission prompt.")
        return [], 0

    new = entries[processed:]
    total = len(entries)

    if not new:
        print(f"\n  No new entries (total: {total}, processed: {processed})")
        return [], total

    print(f"\n  New entries: {len(new)}  (total: {total}, processed: {processed})")

    # Print raw log of all new entries
    print(f"\n  Raw log:")
    for i, entry in enumerate(new):
        ts = entry.get("ts", "?")[:19]
        tool = entry.get("tool", "?")
        inp = entry.get("input", {})
        if tool == "Bash":
            detail = inp.get("command", "")[:120]
        elif tool == "WebFetch":
            detail = inp.get("url", "")[:120]
        elif tool in ("Edit", "Write", "Read"):
            detail = inp.get("file_path", "")[:120]
        elif tool.startswith("mcp__"):
            detail = tool.split("__")[-1]
            tool = "MCP"
        else:
            detail = str(inp)[:120]
        print(f"    {ts}  {tool:10s}  {detail}")

    allow_set = set(allow_list)
    safe_rules: Counter = Counter()
    review_items: list[tuple[dict, str | None]] = []
    dangerous_items: list[dict] = []

    for entry in new:
        tool = entry.get("tool", "")
        inp = entry.get("input", {})
        cat, rule = classify_entry(tool, inp)

        if cat == "safe" and rule:
            safe_rules[rule] += 1
        elif cat == "dangerous":
            dangerous_items.append(entry)
        else:
            review_items.append((entry, rule))

    if safe_rules:
        print(f"\n  Safe operations — add to allow list:")
        for rule, count in safe_rules.most_common():
            tag = " (already present)" if rule in allow_set else ""
            print(f"    + {rule}  (×{count}){tag}")

    if review_items:
        review_rules: Counter = Counter()
        for _entry, rule in review_items:
            if rule:
                review_rules[rule] += 1
        print(f"\n  Needs review ({len(review_items)}):")
        for rule, count in review_rules.most_common():
            tag = " (already present)" if rule in allow_set else ""
            print(f"    ? {rule}  (×{count}){tag}")

    if dangerous_items:
        print(f"\n  Dangerous — keeping manual ({len(dangerous_items)}):")
        for entry in dangerous_items:
            cmd = entry.get("input", {}).get("command", str(entry.get("input", "")))
            print(f"    ✗ {entry.get('tool', '?')}: {cmd[:100]}")

    return entries, total


def report_directories(settings: dict):
    print_section("PHASE 3: additionalDirectories")

    dirs = settings.get("permissions", {}).get("additionalDirectories", [])
    if not dirs:
        print("\n  No additionalDirectories configured.")
        return []

    stale = find_stale_directories(dirs)
    if stale:
        print(f"\n  Stale entries ({len(stale)} of {len(dirs)}):")
        for d, reason in stale:
            print(f"    ✗ {d}")
            print(f"      → {reason}")
    else:
        print(f"\n  All {len(dirs)} directories exist and are non-redundant.")
    return stale


def report_local():
    print_section("PHASE 4: Local settings (settings.local.json)")

    data = load_json(SETTINGS_LOCAL_PATH)
    if not data:
        print("\n  No local settings found.")
        return

    local_allow = data.get("permissions", {}).get("allow", [])
    if not local_allow:
        print("\n  Local allow list is empty.")
        return

    print(f"\n  Entries in settings.local.json ({len(local_allow)}):")
    for entry in local_allow:
        print(f"    · {entry}")
    print("\n  Consider promoting frequently used entries to global settings.")


# --- Apply ---

def apply_changes(
    settings: dict,
    redundant: list[tuple[str, str]],
    hardcoded: list[tuple[str, str]],
    stale_dirs: list[tuple[str, str]],
    log_entries: list[dict],
    total_count: int,
):
    print_section("APPLYING CHANGES")

    allow_list = settings["permissions"]["allow"]
    to_remove = {e for e, _ in redundant} | {e for e, _ in hardcoded}
    new_allow = [e for e in allow_list if e not in to_remove]

    removed = list(to_remove)
    added = []

    # Prune stale additionalDirectories
    dirs = settings.get("permissions", {}).get("additionalDirectories", [])
    stale_set = {d for d, _ in stale_dirs}
    new_dirs = [d for d in dirs if d not in stale_set]
    removed_dirs = sorted(stale_set)

    # Add only safe generalizations from hardcoded
    existing = set(new_allow)
    safe_gen, _review_gen = extract_generalizations(hardcoded, existing)
    for g in safe_gen:
        if g not in existing:
            new_allow.append(g)
            added.append(g)
            existing.add(g)

    # Add safe rules from log
    processed = load_marker()
    new_entries = log_entries[processed:]
    if new_entries:
        for entry in new_entries:
            tool = entry.get("tool", "")
            inp = entry.get("input", {})
            cat, rule = classify_entry(tool, inp)
            if cat == "safe" and rule and rule not in existing:
                new_allow.append(rule)
                added.append(rule)
                existing.add(rule)

    # Deduplicate, sort into tool groups, alphabetize within each group
    new_allow = sort_allow_list(new_allow)
    reordered = new_allow != allow_list

    if removed:
        print(f"\n  Removed ({len(removed)}):")
        for r in sorted(removed):
            print(f"    - {r}")

    if added:
        print(f"\n  Added ({len(added)}):")
        for a in added:
            print(f"    + {a}")

    if removed_dirs:
        print(f"\n  Removed directories ({len(removed_dirs)}):")
        for d in removed_dirs:
            print(f"    - {d}")

    if reordered and not removed and not added:
        print("\n  Allow list re-sorted into tool groups.")

    if not removed and not added and not removed_dirs and not reordered:
        print("\n  No changes needed.")
        if total_count > 0:
            save_marker(total_count)
            print(f"  Log marked as processed up to entry {total_count}.")
        return

    # Backup
    backup_name = f"settings.backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    backup_path = SETTINGS_PATH.parent / backup_name
    backup_path.write_text(SETTINGS_PATH.read_text())
    print(f"\n  Backup: {backup_path}")

    settings["permissions"]["allow"] = new_allow
    if removed_dirs:
        settings["permissions"]["additionalDirectories"] = new_dirs
    SETTINGS_PATH.write_text(dump_settings(settings))
    print(f"  Updated: {SETTINGS_PATH}")

    if total_count > 0:
        save_marker(total_count)
        print(f"  Log marked as processed up to entry {total_count}.")


# --- Main ---

def main():
    apply = "--apply" in sys.argv

    print("=" * 60)
    print("  Claude Code Permission Analyzer")
    print("=" * 60)

    settings = load_json(SETTINGS_PATH)
    if not settings:
        print(f"\nERROR: Cannot read {SETTINGS_PATH}")
        sys.exit(1)

    allow_list = settings.get("permissions", {}).get("allow", [])
    print(f"\n  Settings: {SETTINGS_PATH}")
    print(f"  Log:      {LOG_PATH}")
    print(f"  Rules:    {len(allow_list)} entries in allow list")

    redundant, hardcoded = report_cleanup(allow_list)
    log_entries, total_count = report_log(allow_list)
    stale_dirs = report_directories(settings)
    report_local()

    if apply:
        apply_changes(settings, redundant, hardcoded, stale_dirs, log_entries, total_count)
    else:
        changes = len(redundant) + len(hardcoded) + len(stale_dirs)
        if changes > 0 or log_entries:
            print(f"\n{'─' * 60}")
            print(f"  Run with --apply to apply changes.")
            print(f"{'─' * 60}")


if __name__ == "__main__":
    main()
