#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const path = (process.argv[2] ?? "").trim();
if (!path) {
  console.error("usage: handoff-pickup.ts <absolute-path> [force]");
  process.exit(1);
}
if (!existsSync(path)) {
  console.error(`handoff not found: ${path}`);
  process.exit(1);
}
const force = process.argv.slice(3).some((a) => a === "force" || a === "--force");

const sessionRef = currentSessionRef();
const now = new Date().toISOString();

const content = readFileSync(path, "utf8");
const fm = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
if (!fm) {
  console.error(`no frontmatter in ${path}`);
  process.exit(1);
}
const [, fmRaw, body] = fm;

const kv: Record<string, string> = {};
for (const ln of fmRaw.split("\n")) {
  const m = ln.match(/^([a-z_]+): (.*)$/);
  if (m) kv[m[1]] = m[2];
}

if (kv.created_by && normalizedSessionRef(kv.created_by) === sessionRef) {
  console.error("refusing pickup: current session is the creator");
  process.exit(2);
}

const parseList = (v: string | undefined): string[] => {
  if (!v) return [];
  const s = v.trim();
  if (s.startsWith("[") && s.endsWith("]")) {
    return s.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean);
  }
  return [s];
};

const consumedBy = parseList(kv.consumed_by);
const consumedAt = parseList(kv.consumed_at);
const consumedByCurrentSession = consumedBy.some(
  (ref) => normalizedSessionRef(ref) === sessionRef,
);

const others = consumedBy
  .map((id, i) => ({ id, at: consumedAt[i] ?? "?" }))
  .filter((p) => normalizedSessionRef(p.id) !== sessionRef);
if (others.length > 0 && !consumedByCurrentSession && !force) {
  const rows = others.map((p) => `  - ${p.id}  at ${p.at}`).join("\n");
  process.stdout.write(
    "ALREADY PICKED UP — nothing written, file untouched (no `force`).\n" +
      `${others.length} other session(s) already picked up this handoff:\n${rows}\n` +
      `status: ${kv.status ?? "?"}\n` +
      "This handoff is in progress elsewhere. Confirm with the user before taking it; " +
      "then re-run with `force` as the second argument.\n",
  );
  process.exit(3);
}

if (!consumedByCurrentSession) {
  consumedBy.push(sessionRef);
  consumedAt.push(now);
}

kv.status = "consumed";
kv.consumed_by = `[${consumedBy.join(", ")}]`;
kv.consumed_at = `[${consumedAt.join(", ")}]`;

const order = ["status", "created_by", "created_at", "consumed_by", "consumed_at"];
const newFm = order
  .filter((k) => k in kv)
  .map((k) => `${k}: ${kv[k]}`)
  .join("\n");
writeFileSync(path, `---\n${newFm}\n---\n${body}`);

process.stdout.write(body);

function currentSessionRef(): string {
  const refs = [
    process.env.CODEX_THREAD_ID ? `codex:${process.env.CODEX_THREAD_ID}` : null,
    process.env.CLAUDE_CODE_SESSION_ID ? `claude:${process.env.CLAUDE_CODE_SESSION_ID}` : null,
  ].filter((ref): ref is string => ref !== null);

  if (refs.length === 1) return refs[0];

  const reason = refs.length === 0 ? "no session id found" : "multiple session ids found";
  console.error(`handoff-pickup: ${reason}`);
  process.exit(1);
}

function normalizedSessionRef(ref: string): string {
  return ref.includes(":") ? ref : `claude:${ref}`;
}
