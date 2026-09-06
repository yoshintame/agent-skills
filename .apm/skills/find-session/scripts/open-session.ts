#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { parseArgs } from "node:util";

const HOME = process.env.HOME ?? "";
const PROJECTS = `${HOME}/.claude/projects`;
const IDE_LOCKS = `${HOME}/.claude/ide`;
const DEEP_LINK = "vscode://anthropic.claude-code/open?session=";

const HELP = `
open-session — open a Claude Code session in a VSCode window rooted at its own cwd

Usage:
  open-session <session-id> [--prompt <text>] [--dry-run]

  --prompt   prefill the session's input box
  --dry-run  resolve and report, spawn nothing

Exit codes: 0 opened / 2 usage / 3 transcript not found / 4 window never came up
`.trimStart();

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { prompt: { type: "string" }, "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" } },
});

if (values.help || positionals.length !== 1) {
  process.stdout.write(HELP);
  process.exit(values.help ? 0 : 2);
}

function say(line: string): void {
  console.log(`open-session: ${line}`);
}

function fail(line: string, code: number): never {
  console.error(`open-session: ${line}`);
  process.exit(code);
}

const id = positionals[0]!.trim().replace(/^.*session=/, "");
if (!/^[0-9a-fA-F-]{8,}$/.test(id)) fail(`not a session id: ${positionals[0]}`, 2);

// ─── cwd: read it from the transcript, never from the project-dir name ───
// The dir name is cwd with [^a-zA-Z0-9] collapsed to '-', which is lossy and
// does not invert. Every JSONL row carries the real cwd.
const transcripts: string[] = [];
for await (const p of new Bun.Glob(`**/${id}.jsonl`).scan({ cwd: PROJECTS, absolute: true })) transcripts.push(p);
if (transcripts.length === 0) fail(`no transcript for ${id} under ${PROJECTS}`, 3);

const cwdOf = async (file: string): Promise<string | null> => {
  const head = await Bun.file(file).slice(0, 256 * 1024).text();
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    try {
      const cwd = JSON.parse(line).cwd;
      if (typeof cwd === "string" && cwd) return cwd;
    } catch { }
  }
  return null;
};

const cwds = [...new Set((await Promise.all(transcripts.map(cwdOf))).filter((c): c is string => c !== null))];
if (cwds.length === 0) fail(`transcript carries no cwd: ${transcripts[0]}`, 3);
const cwd = cwds[0]!;

// ─── is a live window already rooted there? ───
// Each VSCode window's Claude Code extension writes ~/.claude/ide/<port>.lock
// with its workspaceFolders. Locks outlive crashed windows, so the pid is the
// liveness check.
const windowIsUp = (): boolean => {
  let locks: string[];
  try { locks = readdirSync(IDE_LOCKS).filter((n) => n.endsWith(".lock")); } catch { return false; }
  return locks.some((name) => {
    try {
      const lock = JSON.parse(readFileSync(`${IDE_LOCKS}/${name}`, "utf8"));
      if (!Array.isArray(lock.workspaceFolders) || !lock.workspaceFolders.includes(cwd)) return false;
      process.kill(lock.pid, 0);
      return true;
    } catch { return false; }
  });
};

const url = `${DEEP_LINK}${id}${values.prompt ? `&prompt=${encodeURIComponent(values.prompt)}` : ""}`;
const alreadyUp = windowIsUp();

say(`${id}`);
say(`cwd: ${cwd}${cwds.length > 1 ? `  (also: ${cwds.slice(1).join(", ")})` : ""}`);
say(`window: ${alreadyUp ? "already open — focusing it" : "not open — launching"}`);
say(`url: ${url}`);

if (values["dry-run"]) process.exit(0);

// `code <folder>` focuses the window already holding that folder, else opens one.
// Pin it to the VSCode bundle rather than trusting PATH: `code` also ships with
// Cursor, and launching Cursor would leave the vscode:// URL going elsewhere.
const VSCODE_CLI = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
const opener = existsSync(VSCODE_CLI)
  ? [VSCODE_CLI, cwd]
  : ["open", "-b", "com.microsoft.VSCode", cwd];
const spawned = Bun.spawnSync(opener, { stdout: "pipe", stderr: "pipe" });
if (spawned.exitCode !== 0) fail(`${opener[0]} failed: ${spawned.stderr.toString().trim()}`, 4);

// Two reasons to wait, both fatal if skipped. The URI is dispatched to the
// *active* window, so it must be the new one; and on macOS with zero windows
// open VSCode's main process strips `session` from the query before dispatch
// (it is reserved for vscode:openChatSession), which silently degrades the
// deep link into "open a blank session".
const deadline = Date.now() + 30_000;
while (!windowIsUp()) {
  if (Date.now() > deadline) fail(`no window on ${cwd} after 30s — nothing opened`, 4);
  await Bun.sleep(250);
}
// The lock appears when the extension's server binds; window focus lands a beat later.
await Bun.sleep(alreadyUp ? 400 : 1200);

const handed = Bun.spawnSync(["open", url], { stdout: "pipe", stderr: "pipe" });
if (handed.exitCode !== 0) fail(`open ${url} failed: ${handed.stderr.toString().trim()}`, 4);
say(`handed off to the window on ${cwd}`);
