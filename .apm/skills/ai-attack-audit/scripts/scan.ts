#!/usr/bin/env bun
import { readdirSync, statSync, readFileSync } from "fs";
import { join } from "path";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const target = argv.find((a) => !a.startsWith("--"));
if (!target) {
  console.error("usage: scan.ts <file|dir> [--json]");
  process.exit(2);
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "vendor"]);
const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

type Finding = { severity: string; file: string; line: number; col: number; category: string; match: string };
const findings: Finding[] = [];

function walk(p: string): string[] {
  const st = statSync(p);
  if (st.isFile()) return [p];
  if (!st.isDirectory()) return [];
  const out: string[] = [];
  for (const name of readdirSync(p)) {
    if (SKIP_DIRS.has(name)) continue;
    out.push(...walk(join(p, name)));
  }
  return out;
}

function classifyChar(cp: number): { klass: string; sev: string } | null {
  if (cp === 0x00ad) return { klass: "soft-hyphen", sev: "low" };
  if (cp >= 0x202a && cp <= 0x202e) return { klass: "bidi-override", sev: "high" };
  if (cp >= 0x2066 && cp <= 0x2069) return { klass: "bidi-isolate", sev: "high" };
  if (cp >= 0xe0000 && cp <= 0xe007f) return { klass: "unicode-tag", sev: "high" };
  if (cp >= 0x200b && cp <= 0x200f) return { klass: "zero-width", sev: "medium" };
  if (cp === 0x2060 || cp === 0xfeff || cp === 0x180e) return { klass: "zero-width", sev: "medium" };
  return null;
}

function foreignScript(cp: number): string | null {
  if (cp >= 0x0400 && cp <= 0x04ff) return "Cyrillic";
  if (cp >= 0x0370 && cp <= 0x03ff) return "Greek";
  return null;
}

const RULES: { re: RegExp; cat: string; sev: string }[] = [
  { re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/i, cat: "shell:fetch-pipe-sh", sev: "critical" },
  { re: /\|\s*(sudo\s+)?(ba)?sh\b/i, cat: "shell:pipe-sh", sev: "high" },
  { re: /\/dev\/tcp\//, cat: "shell:reverse-tcp", sev: "critical" },
  { re: /\bnc\b[^\n]*\s-e\b/, cat: "shell:netcat-exec", sev: "critical" },
  { re: /base64\s+(-d|--decode|-D)\b/i, cat: "shell:base64-decode", sev: "medium" },
  { re: /\bchmod\s+\+x\b/, cat: "shell:chmod-exec", sev: "low" },
  { re: /\beval\s*[("'`]/, cat: "code:eval", sev: "medium" },
  { re: /(~\/\.ssh|id_rsa|id_ed25519)/, cat: "exfil:ssh-keys", sev: "medium" },
  { re: /(~\/\.aws|AWS_SECRET|AWS_ACCESS_KEY)/, cat: "exfil:aws-creds", sev: "medium" },
  { re: /(GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)/, cat: "exfil:token-ref", sev: "medium" },
  { re: /\b[A-Z][A-Z0-9_]{2,}_(TOKEN|KEY|SECRET|PASSWORD)\b/, cat: "exfil:secret-ref", sev: "low" },
  { re: /(^|[\s"'/=])\.env(\.local|\.production)?\b/, cat: "exfil:dotenv", sev: "low" },
  { re: /\b(printenv|os\.environ|process\.env)\b/, cat: "exfil:env-read", sev: "low" },
  { re: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|messages|context)/i, cat: "inject:override", sev: "high" },
  { re: /disregard\s+(all\s+)?(previous|prior|the\s+above|earlier)/i, cat: "inject:override", sev: "high" },
  { re: /override\s+(your|the|all)\s+(instructions|guidelines|rules|directives)/i, cat: "inject:override", sev: "high" },
  { re: /do\s+not\s+(tell|mention|inform|reveal|notify)[^\n]{0,40}(user|human|operator)/i, cat: "inject:conceal", sev: "high" },
  { re: /without\s+(asking|telling|informing|notifying)\s+the\s+(user|human)/i, cat: "inject:conceal", sev: "high" },
  { re: /<\/?(system|assistant|im_start|im_end|tool_call)>/i, cat: "inject:fake-role-tag", sev: "high" },
  { re: /\byou\s+are\s+now\b/i, cat: "inject:role-switch", sev: "medium" },
  { re: /\bnew\s+instructions?\s*:/i, cat: "inject:new-instructions", sev: "medium" },
  { re: /\bsystem\s+prompt\b/i, cat: "inject:system-prompt-ref", sev: "low" },
  { re: /https?:\/\/(\d{1,3}\.){3}\d{1,3}/, cat: "net:raw-ip-url", sev: "medium" },
];

function scanText(file: string, text: string) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let col = 0;
    for (const ch of line) {
      col++;
      const cp = ch.codePointAt(0)!;
      const u = classifyChar(cp);
      if (u) {
        const hex = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
        findings.push({ severity: u.sev, file, line: i + 1, col, category: `unicode:${u.klass}`, match: hex });
      }
    }
    for (const m of line.matchAll(/[A-Za-zͰ-ϿЀ-ӿ]{2,}/g)) {
      const tok = m[0];
      if (!/[A-Za-z]/.test(tok)) continue;
      let foreign: string | null = null;
      for (const ch of tok) {
        const s = foreignScript(ch.codePointAt(0)!);
        if (s) { foreign = s; break; }
      }
      if (foreign) findings.push({ severity: "medium", file, line: i + 1, col: (m.index ?? 0) + 1, category: `unicode:homoglyph-${foreign}`, match: tok.slice(0, 40) });
    }
    for (const r of RULES) {
      const mm = line.match(r.re);
      if (mm) findings.push({ severity: r.sev, file, line: i + 1, col: (mm.index ?? 0) + 1, category: r.cat, match: mm[0].slice(0, 80) });
    }
  }
}

function scanPackageJson(file: string, text: string) {
  let pkg: any;
  try { pkg = JSON.parse(text); } catch { return; }
  for (const h of ["preinstall", "install", "postinstall", "prepare", "prepublish"]) {
    if (pkg.scripts?.[h]) findings.push({ severity: "medium", file, line: 1, col: 1, category: "deps:install-hook", match: `${h}: ${String(pkg.scripts[h]).slice(0, 70)}` });
  }
  if (pkg.dependencies || pkg.devDependencies) findings.push({ severity: "low", file, line: 1, col: 1, category: "deps:present", match: "run Socket + Snyk (see SKILL.md)" });
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const files = walk(target);
for (const f of files) {
  let buf: Buffer;
  try { buf = readFileSync(f); } catch { continue; }
  if (buf.length > 2_000_000 || isBinary(buf)) continue;
  const text = buf.toString("utf8");
  scanText(f, text);
  if (f.endsWith("package.json")) scanPackageJson(f, text);
}

findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);

if (json) {
  console.log(JSON.stringify(findings, null, 2));
} else {
  for (const f of findings) console.log(`${f.severity.toUpperCase().padEnd(8)} ${f.file}:${f.line}:${f.col}\t${f.category}\t${f.match}`);
  const c: Record<string, number> = {};
  for (const f of findings) c[f.severity] = (c[f.severity] || 0) + 1;
  console.error(`\n${findings.length} findings — ${["critical", "high", "medium", "low"].map((s) => `${c[s] || 0} ${s}`).join(", ")} (${files.length} files)`);
}

process.exit(findings.some((f) => f.severity === "critical" || f.severity === "high") ? 1 : 0);
