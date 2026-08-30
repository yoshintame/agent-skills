#!/usr/bin/env bun
const DEFAULT_REPOS = [
  "anthropics/skills",
  "anthropics/claude-plugins-official",
  "cursor/plugins",
  "mattpocock/skills",
  "obra/superpowers",
  "garrytan/gstack",
];

const args = process.argv.slice(2);
const json = args.includes("--json");
const repos = args.filter((a) => !a.startsWith("--"));
const targets = repos.length ? repos : DEFAULT_REPOS;

const token = process.env.GITHUB_TOKEN;
const apiHeaders: Record<string, string> = { "User-Agent": "find-skills" };
if (token) apiHeaders.Authorization = `Bearer ${token}`;

type Row = { repo: string; path: string; name: string; description: string };

async function tree(repo: string): Promise<{ paths: string[]; branch: string } | null> {
  for (const branch of ["main", "master"]) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`,
      { headers: apiHeaders },
    );
    if (res.status === 404) continue;
    if (res.status === 403) {
      console.error(`! ${repo}: rate-limited (set GITHUB_TOKEN)`);
      return null;
    }
    if (!res.ok) {
      console.error(`! ${repo}: HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { tree: { path: string; type: string }[]; truncated: boolean };
    if (body.truncated) console.error(`! ${repo}: tree truncated, results partial`);
    const paths = body.tree
      .filter((n) => n.type === "blob" && n.path.endsWith("SKILL.md"))
      .map((n) => n.path);
    return { paths, branch };
  }
  console.error(`! ${repo}: no main/master branch`);
  return null;
}

function stripQuotes(v: string) {
  return v.replace(/^["']|["']$/g, "").trim();
}

function readKey(fm: string, key: string): string {
  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp(`^${key}:\\s*(.*)$`));
    if (!m) continue;
    let v = m[1].trim();
    if (v === "" || /^[|>][-+]?$/.test(v)) {
      const buf: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s+\S/.test(lines[j])) buf.push(lines[j].trim());
        else if (lines[j].trim() === "") buf.push("");
        else break;
      }
      v = buf.join(" ").trim();
    }
    return stripQuotes(v);
  }
  return "";
}

async function skill(repo: string, branch: string, path: string): Promise<Row> {
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${path}`);
  let name = "";
  let description = "";
  if (res.ok) {
    const text = await res.text();
    if (text.startsWith("---")) {
      const end = text.indexOf("\n---", 3);
      const fm = end === -1 ? text.slice(3) : text.slice(3, end);
      name = readKey(fm, "name");
      description = readKey(fm, "description").replace(/\s+/g, " ");
    }
  }
  if (!name) name = path.split("/").slice(-2)[0] ?? path;
  if (description.length > 200) description = description.slice(0, 197) + "...";
  return { repo, path, name, description };
}

const rows: Row[] = [];
for (const repo of targets) {
  const t = await tree(repo);
  if (!t) continue;
  const batch = await Promise.all(t.paths.map((p) => skill(repo, t.branch, p)));
  rows.push(...batch);
}

if (json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const r of rows) console.log(`${r.repo}\t${r.path}\t${r.name}\t${r.description}`);
  console.error(`\n${rows.length} skills across ${targets.length} repos`);
}
