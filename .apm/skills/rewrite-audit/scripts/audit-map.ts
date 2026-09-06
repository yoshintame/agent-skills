#!/usr/bin/env bun
// audit-map <repo> <base> <head> [pathspec...]
// Prints a markdown table of what a rewrite did to each file between two commits:
// renames with similarity (git -M; 100 = body identical, only frontmatter differs), deletions (need a manual map),
// additions (the new homes). Pass a pathspec wide enough to cover both ends of every move, or rename detection degrades to D + A.

import { $ } from "bun";

const [repo, base, head, ...paths] = process.argv.slice(2);
if (!repo || !base || !head) {
  console.error("usage: audit-map <repo> <base> <head> [pathspec...]");
  process.exit(2);
}

const args = ["diff", "--name-status", "-M50%", "-z", `${base}..${head}`, "--", ...paths];
const raw = await $`git -C ${repo} ${args}`.text();
const fields = raw.split("\0").filter(Boolean);

type Row = { kind: "renamed" | "deleted" | "added" | "modified"; from?: string; to?: string; similarity?: number };
const rows: Row[] = [];
for (let i = 0; i < fields.length; ) {
  const status = fields[i];
  if (status.startsWith("R") || status.startsWith("C")) {
    rows.push({ kind: "renamed", from: fields[i + 1], to: fields[i + 2], similarity: Number(status.slice(1)) });
    i += 3;
  } else if (status === "D") {
    rows.push({ kind: "deleted", from: fields[i + 1] });
    i += 2;
  } else if (status === "A") {
    rows.push({ kind: "added", to: fields[i + 1] });
    i += 2;
  } else {
    rows.push({ kind: "modified", from: fields[i + 1], to: fields[i + 1] });
    i += 2;
  }
}

const body = async (rev: string, path: string) =>
  (await $`git -C ${repo} show ${rev}:${path}`.text()).replace(/^---\n[\s\S]*?\n---\n/, "").trim();

for (const r of rows) {
  if (r.kind !== "renamed") continue;
  if ((await body(base, r.from!)) === (await body(head, r.to!))) r.similarity = 100;
}

const section = (title: string, list: Row[], line: (r: Row) => string) => {
  if (!list.length) return;
  console.log(`\n## ${title} (${list.length})\n`);
  for (const r of list) console.log(line(r));
};

const renamed = rows.filter((r) => r.kind === "renamed").sort((a, b) => (a.similarity ?? 0) - (b.similarity ?? 0));
section("Переезд без правок тела — сверить только frontmatter", renamed.filter((r) => r.similarity === 100), (r) => `- \`${r.from}\` → \`${r.to}\``);
section("Переезд с правками — сверить по карте", renamed.filter((r) => r.similarity !== 100), (r) => `- R${r.similarity} \`${r.from}\` → \`${r.to}\``);
section("Удалены — дома только из карты handoff'а", rows.filter((r) => r.kind === "deleted"), (r) => `- \`${r.from}\` — \`git -C ${repo} show ${base}:${r.from}\``);
section("Добавлены — новые дома", rows.filter((r) => r.kind === "added"), (r) => `- \`${r.to}\``);
section("Изменены на месте", rows.filter((r) => r.kind === "modified"), (r) => `- \`${r.from}\``);
