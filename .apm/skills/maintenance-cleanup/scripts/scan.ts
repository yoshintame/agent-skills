#!/usr/bin/env bun
import { exec } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";

const sh = promisify(exec);
const HOME = homedir();
const expand = (p: string) => p.replace(/^~/, HOME);

const SPOTS = [
  ["trash", "~/.Trash", "macOS trash; Finder -> Empty if rm leaves items"],
  ["trash", "~/.local/share/Trash", "gtrash: `gtrash prune --day 0 -f`"],
  ["vm", "~/Library/Containers/com.docker.docker", "Docker.raw; del Data/vms only if moved to OrbStack"],
  ["vm", "~/Library/Group Containers/HUAQ24HBR6.dev.orbstack", "OrbStack; prune via `docker system prune -a --volumes`"],
  ["cache", "~/.npm/_cacache", "npm cache"],
  ["cache", "~/.cache", "del listed subdirs (hf/uv/pnpm/nix/act/.bun), not whole dir; `*` hides .bun"],
  ["cache", "~/Library/Caches", "Homebrew(`brew cleanup`)/restic/playwright/cypress/spotify"],
  ["cache", "/nix/store", "`nix-collect-garbage -d`"],
  ["data", "~/Library/Application Support/Steam", "games"],
  ["data", "~/Movies", "video"],
  ["data", "~/Downloads", ""],
] as const;

const human = (kb: number) =>
  kb >= 1048576 ? `${(kb / 1048576).toFixed(1)}G` : kb >= 1024 ? `${Math.round(kb / 1024)}M` : `${kb}K`;

const sizeKb = async (p: string) => {
  try {
    const { stdout } = await sh(`du -sk ${JSON.stringify(expand(p))} 2>/dev/null`);
    return parseInt(stdout.split("\t")[0], 10) || 0;
  } catch {
    return 0;
  }
};

const { stdout: df } = await sh("df -h /System/Volumes/Data | tail -1");
const f = df.trim().split(/\s+/);
console.log(`Free ${f[3]} of ${f[1]} (${f[4]} used)  [/System/Volumes/Data, not df /]\n`);

const rows = await Promise.all(
  SPOTS.map(async ([cat, path, note]) => ({ cat, path, note, kb: await sizeKb(path) })),
);
rows.sort((a, b) => b.kb - a.kb);

const tag = { trash: "SAFE", cache: "SAFE", vm: "ASK ", data: "ASK " } as const;
for (const r of rows.filter((r) => r.kb > 0))
  console.log(`${human(r.kb).padStart(6)}  ${tag[r.cat]}  ${r.path.replace(HOME, "~")}${r.note ? `  - ${r.note}` : ""}`);
