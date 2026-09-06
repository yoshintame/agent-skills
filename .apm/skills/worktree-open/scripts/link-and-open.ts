#!/usr/bin/env bun
import fs from "node:fs";

const HOME = process.env.HOME ?? "";
const LINKER = `${HOME}/.dotfiles/packages/link-session/src/cli.ts`;

type Run = { code: number; out: string; err: string };
function run(cmd: string, args: string[]): Run {
  const r = Bun.spawnSync([cmd, ...args]);
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

function projectDir(absPath: string): string {
  return `${HOME}/.claude/projects/${absPath.replace(/[^a-zA-Z0-9]/g, "-")}`;
}

function currentSessionId(dirs: string[]): string {
  const fromEnv = process.env.CLAUDE_CODE_SESSION_ID;
  if (fromEnv?.trim()) return fromEnv.trim();
  const candidates = dirs.flatMap((dir) => {
    try {
      return fs
        .readdirSync(dir)
        .filter((n) => n.endsWith(".jsonl"))
        .map((n) => ({ id: n.replace(/\.jsonl$/, ""), m: fs.statSync(`${dir}/${n}`).mtimeMs }));
    } catch {
      return [];
    }
  });
  return candidates.sort((a, b) => b.m - a.m)[0]?.id ?? "";
}

const cwd = process.cwd();

const list = run("git", ["-C", cwd, "worktree", "list", "--porcelain"]);
if (list.code !== 0) {
  console.error(`worktree-open: not a git repo: ${cwd}`);
  process.exit(1);
}
const mainLine = list.out.split("\n").find((l) => l.startsWith("worktree "));
const main = mainLine ? mainLine.slice("worktree ".length) : "";
const isWorktree = run("git", ["-C", cwd, "rev-parse", "--absolute-git-dir"]).out.includes("/worktrees/");
const sessionId = currentSessionId([projectDir(main), projectDir(cwd)]);

if (!isWorktree || !main || main === cwd) {
  console.log(`worktree-open: cwd is the main checkout, not a linked worktree — skipping link`);
} else if (!sessionId) {
  console.log(`worktree-open: no current session id (CLAUDE_CODE_SESSION_ID unset, no transcript) — skipping link`);
} else if (!fs.existsSync(LINKER)) {
  console.error(`worktree-open: linker not found at ${LINKER} — skipping link`);
} else {
  const lk = run("bun", [LINKER, "link", sessionId, main, cwd]);
  console.log(`worktree-open: link ${sessionId} -> worktree: ${(lk.err || lk.out || "done").split("\n").pop()}`);
}

const opened = run("open", ["-a", "Visual Studio Code", cwd]);
if (opened.code === 0) console.log(`worktree-open: opened VSCode on ${cwd}`);
else console.error(`worktree-open: failed to open VSCode (open exit ${opened.code}): ${opened.err}`);
