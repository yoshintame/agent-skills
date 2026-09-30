#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { PROJECTS, cwdOf, titleOf, transcriptsOf } from "./session-meta.ts";

const HOME = process.env.HOME ?? "";
const PASEO_AGENTS = `${process.env.PASEO_HOME ?? `${HOME}/.paseo`}/agents`;
const IDE_LOCKS = `${HOME}/.claude/ide`;
const DEEP_LINK = "vscode://anthropic.claude-code/open?session=";

const HELP = `
open-session — open a Claude Code session in a VSCode window rooted at its own cwd, or in Paseo

Usage:
  open-session <session-id> [--paseo] [--prompt <text>] [--dry-run]

  --paseo    open as a Paseo agent: focus the existing one, else import it
  --prompt   prefill the session's input box (VSCode only)
  --dry-run  resolve and report, spawn nothing

Exit codes: 0 opened / 2 usage / 3 transcript not found / 4 window never came up / 5 paseo failed
`.trimStart();

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { paseo: { type: "boolean" }, prompt: { type: "string" }, "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" } },
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

const transcripts = await transcriptsOf(id);
if (transcripts.length === 0) fail(`no transcript for ${id} under ${PROJECTS}`, 3);

const cwds = [...new Set((await Promise.all(transcripts.map(cwdOf))).filter((c): c is string => c !== null))];
if (cwds.length === 0) fail(`transcript carries no cwd: ${transcripts[0]}`, 3);
const cwd = cwds[0]!;
const title = transcripts.map(titleOf).find((t) => t !== null);

say(`${id}${title ? `  ${title}` : ""}`);
say(`cwd: ${cwd}${cwds.length > 1 ? `  (also: ${cwds.slice(1).join(", ")})` : ""}`);

if (values.paseo) await openInPaseo();

type PaseoAgent = { id: string; archived: boolean; mtime: number };

function paseoAgentOf(sessionId: string): PaseoAgent | null {
  const found: PaseoAgent[] = [];
  for (const file of new Bun.Glob("*/*.json").scanSync({ cwd: PASEO_AGENTS, absolute: true })) {
    try {
      const a = JSON.parse(readFileSync(file, "utf8"));
      if (a.persistence?.sessionId !== sessionId) continue;
      found.push({ id: a.id, archived: a.archivedAt != null, mtime: Bun.file(file).lastModified });
    } catch { }
  }
  found.sort((x, y) => Number(x.archived) - Number(y.archived) || y.mtime - x.mtime);
  return found[0] ?? null;
}

function paseo(args: string[]): void {
  const r = Bun.spawnSync(["paseo", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) fail(`paseo ${args.join(" ")} failed: ${(r.stderr.toString() || r.stdout.toString()).trim()}`, 5);
}

async function openInPaseo(): Promise<never> {
  const existing = paseoAgentOf(id);
  const live = existing && !existing.archived ? existing : null;
  say(`paseo: ${live ? `agent ${live.id} — opening` : existing ? `agent ${existing.id} archived — re-importing` : "not imported — importing"}`);
  if (values["dry-run"]) process.exit(0);

  if (!live) paseo(["import", id, "--provider", "claude", "--cwd", cwd, "-q"]);
  const agent = live ?? paseoAgentOf(id);
  if (!agent || agent.archived) fail(`paseo import of ${id} left no live agent`, 5);
  paseo(["agent", "open", agent.id]);
  say(`opened paseo agent ${agent.id}`);
  process.exit(0);
}

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
