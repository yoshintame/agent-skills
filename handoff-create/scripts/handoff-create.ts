#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const slug = (process.argv[2] ?? "").trim();
if (!slug) {
  console.error("usage: handoff-create.ts <kebab-slug>");
  process.exit(1);
}

const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? "unknown";
const now = new Date().toISOString();
const dir = `${process.env.HOME}/.claude/handoffs/${process.cwd().replaceAll("/", "-")}`;
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
created_by: ${sessionId}
created_at: ${now}
---

<!-- handoff body -->
`,
);

console.log(path);
console.log(`/handoff-pickup ${path}`);
