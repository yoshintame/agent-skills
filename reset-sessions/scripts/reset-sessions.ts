#!/usr/bin/env bun
import { execSync } from "node:child_process";

const PATTERN = /anthropic\.claude-code.*native-binary/;
const dryRun = process.argv.includes("--dry-run");
const killAll = process.argv.includes("--all");

type Proc = { pid: number; ppid: number; rss: number; cmd: string };

function snapshot(): Proc[] {
  const out = execSync("ps -axo pid=,ppid=,rss=,command=", {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const procs: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (m) procs.push({ pid: +m[1], ppid: +m[2], rss: +m[3], cmd: m[4] });
  }
  return procs;
}

const isSession = (p: Proc) => PATTERN.test(p.cmd);
const mb = (kb: number) => Math.round(kb / 1024);

function findAncestor(procs: Proc[], start: number): number | undefined {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const seen = new Set<number>();
  let cur = byPid.get(start);
  while (cur && cur.pid > 1 && !seen.has(cur.pid)) {
    seen.add(cur.pid);
    if (isSession(cur)) return cur.pid;
    cur = byPid.get(cur.ppid);
  }
  return undefined;
}

function subtree(procs: Proc[], root: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const p of procs) (children.get(p.ppid) ?? children.set(p.ppid, []).get(p.ppid)!).push(p.pid);
  const out = new Set<number>([root]);
  const stack = [root];
  while (stack.length) {
    for (const c of children.get(stack.pop()!) ?? []) {
      if (!out.has(c)) { out.add(c); stack.push(c); }
    }
  }
  return out;
}

const before = snapshot();
const sessions = before.filter(isSession);
const beforeMem = sessions.reduce((s, p) => s + p.rss, 0);

let spare = new Set<number>();
let mine: number | undefined;
if (!killAll) {
  mine = findAncestor(before, process.pid);
  if (mine !== undefined) spare = subtree(before, mine);
}
const targets = sessions.filter((p) => !spare.has(p.pid));

console.log(`Сессий найдено: ${sessions.length} (${mb(beforeMem)} MB)`);
if (mine !== undefined) console.log(`Текущая pid=${mine} + поддерево (${spare.size} проц.) — щажу`);
else if (!killAll) console.log(`Текущая сессия не определена (запуск вне сессии) — под нож все`);

if (targets.length === 0) { console.log("Нечего убивать."); process.exit(0); }

if (dryRun) {
  console.log(`\n[dry-run] Убил бы ${targets.length}:`);
  for (const p of targets) console.log(`  pid=${p.pid}  ${mb(p.rss)} MB`);
  process.exit(0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitGone(pids: number[], ms: number): Promise<number[]> {
  const end = Date.now() + ms;
  let alive = pids;
  while (alive.length && Date.now() < end) {
    await sleep(250);
    const live = new Set(snapshot().filter(isSession).map((p) => p.pid));
    alive = alive.filter((pid) => live.has(pid));
  }
  return alive;
}

const targetPids = targets.map((p) => p.pid);
for (const pid of targetPids) {
  try { process.kill(pid, "SIGTERM"); } catch {}
}

let alive = await waitGone(targetPids, 3000);
if (alive.length) {
  for (const pid of alive) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  alive = await waitGone(alive, 2000);
}

const stuck = new Set(alive);
const killed = targets.filter((p) => !stuck.has(p.pid));
const freedMem = killed.reduce((s, p) => s + p.rss, 0);
const after = snapshot().filter(isSession);
const afterMem = after.reduce((s, p) => s + p.rss, 0);

console.log(`\nУбито: ${killed.length}/${targets.length}. Освобождено ~${mb(freedMem)} MB. Осталось сессий: ${after.length} (${mb(afterMem)} MB).`);
if (alive.length) console.log(`Не отозвались даже на SIGKILL (зомби/reparent): ${alive.join(", ")}`);
