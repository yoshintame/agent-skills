#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const slug = (process.argv[2] ?? "").trim();
if (!slug) {
  console.error("usage: handoff-create.ts <kebab-slug>");
  process.exit(1);
}

const sessionRef = currentSessionRef();
const now = new Date().toISOString();
const dir = `${process.env.HOME}/.agents/handoffs/${process.cwd().replaceAll("/", "-")}`;
const path = `${dir}/${slug}.md`;

if (existsSync(path)) {
  console.error(`already exists: ${path}`);
  process.exit(1);
}

mkdirSync(dir, { recursive: true });
writeFileSync(
  path,
  `---
status: open
created_by: ${sessionRef}
created_at: ${now}
---

<!-- handoff body -->
`,
);

console.log(path);
console.log(`/handoff-pickup ${path}`);

function currentSessionRef(): string {
  const refs = [
    process.env.CODEX_THREAD_ID ? `codex:${process.env.CODEX_THREAD_ID}` : null,
    process.env.CLAUDE_CODE_SESSION_ID ? `claude:${process.env.CLAUDE_CODE_SESSION_ID}` : null,
  ].filter((ref): ref is string => ref !== null);

  if (refs.length === 1) return refs[0];

  const reason = refs.length === 0 ? "no session id found" : "multiple session ids found";
  console.error(`handoff-create: ${reason}`);
  process.exit(1);
}
