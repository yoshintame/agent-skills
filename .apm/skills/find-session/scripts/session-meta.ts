import { closeSync, openSync, readSync, statSync } from "node:fs";

export const PROJECTS = `${process.env.HOME}/.claude/projects`;

const TITLE_MARK = '"type":"custom-title"';
const TAIL_CHUNK = 1024 * 1024;

export function titleOf(file: string): string | null {
  let fd: number;
  try { fd = openSync(file, "r"); } catch { return null; }
  try {
    const size = statSync(file).size;
    let end = size;
    let carry = "";
    while (end > 0) {
      const start = Math.max(0, end - TAIL_CHUNK);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString("utf8") + carry;
      const lines = text.split("\n");
      carry = start > 0 ? lines.shift()! : "";
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]!.includes(TITLE_MARK)) continue;
        try {
          const t = JSON.parse(lines[i]!).customTitle;
          if (typeof t === "string" && t) return t;
        } catch { }
      }
      end = start;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

export async function transcriptsOf(id: string): Promise<string[]> {
  const out: string[] = [];
  for await (const p of new Bun.Glob(`**/${id}.jsonl`).scan({ cwd: PROJECTS, absolute: true })) out.push(p);
  return out;
}

// The project-dir name is cwd with [^a-zA-Z0-9] collapsed to '-', which is
// lossy and does not invert. Every JSONL row carries the real cwd.
export async function cwdOf(file: string): Promise<string | null> {
  const head = await Bun.file(file).slice(0, 256 * 1024).text();
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    try {
      const cwd = JSON.parse(line).cwd;
      if (typeof cwd === "string" && cwd) return cwd;
    } catch { }
  }
  return null;
}
