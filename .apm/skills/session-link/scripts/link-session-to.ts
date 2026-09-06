#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const HOME = process.env.HOME ?? "";
const LINKER = `${HOME}/.dotfiles/packages/link-session/src/cli.ts`;

const HELP = `
link-session-to — make a Claude Code session resumable from another directory

Usage:
  link-session-to <dst-cwd> [src-cwd] [--session <id>]

  dst-cwd   directory the session should become visible from
  src-cwd   directory the session currently belongs to (default: cwd)
  --session session id (default: $CLAUDE_CODE_SESSION_ID, else newest transcript in src)

Exit codes: 0 linked / already linked, 2 usage or resolution error, 3 transcript not found
`.trimStart();

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { session: { type: "string" }, help: { type: "boolean", short: "h" } },
});

if (values.help || positionals.length === 0) {
  process.stdout.write(HELP);
  process.exit(values.help ? 0 : 2);
}

function fail(message: string): never {
  console.error(`session-link: ${message}`);
  process.exit(2);
}

function resolveDir(input: string, label: string): string {
  const expanded = input.startsWith("~") ? path.join(HOME, input.slice(1)) : input;
  const abs = path.resolve(expanded);
  if (!fs.existsSync(abs)) fail(`${label} does not exist: ${abs}`);
  if (!fs.statSync(abs).isDirectory()) fail(`${label} is not a directory: ${abs}`);
  return fs.realpathSync(abs);
}

function projectDir(absPath: string): string {
  return `${HOME}/.claude/projects/${absPath.replace(/[^a-zA-Z0-9]/g, "-")}`;
}

function newestTranscriptId(dir: string): string {
  try {
    return (
      fs
        .readdirSync(dir)
        .filter((n) => n.endsWith(".jsonl"))
        .map((n) => ({ id: n.replace(/\.jsonl$/, ""), m: fs.statSync(`${dir}/${n}`).mtimeMs }))
        .sort((a, b) => b.m - a.m)[0]?.id ?? ""
    );
  } catch {
    return "";
  }
}

const dst = resolveDir(positionals[0]!, "dst-cwd");
const src = resolveDir(positionals[1] ?? process.cwd(), "src-cwd");
if (src === dst) fail(`src-cwd and dst-cwd are the same path: ${src}`);

if (!fs.existsSync(LINKER)) fail(`linker not found at ${LINKER}`);

const sessionId = (values.session ?? process.env.CLAUDE_CODE_SESSION_ID ?? "").trim() || newestTranscriptId(projectDir(src));
if (!sessionId) fail(`no session id (pass --session; $CLAUDE_CODE_SESSION_ID unset and no transcript under ${projectDir(src)})`);

const linked = Bun.spawnSync(["bun", LINKER, "link", sessionId, src, dst]);
const verdict = (linked.stderr.toString().trim() || linked.stdout.toString().trim() || "done").split("\n").pop();
console.log(`session-link: ${sessionId}`);
console.log(`session-link: ${src} -> ${dst}`);
console.log(`session-link: ${verdict}`);

if (linked.exitCode !== 0) process.exit(linked.exitCode);

const mirror = `${projectDir(dst)}/${sessionId}.jsonl`;
try {
  const s = fs.statSync(mirror);
  console.log(`session-link: verified inode=${s.ino} nlink=${s.nlink}`);
  if (s.nlink < 2) console.error(`session-link: nlink is ${s.nlink} — mirror is not a hardlink to the source`);
} catch {
  console.error(`session-link: mirror missing after link: ${mirror}`);
  process.exit(2);
}
