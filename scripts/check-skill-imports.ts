import { readdirSync, readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { extname, join, relative } from "node:path"

const root = join(import.meta.dir, "..", ".apm", "skills")
const loaders: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".cjs": "js",
}
const builtins = new Set([...builtinModules, "bun"])
const findings: string[] = []

function scan(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      scan(path)
      continue
    }
    const loader = loaders[extname(path)]
    if (!loader) continue
    const source = readFileSync(path, "utf8").replace(/^#![^\n]*/, "")
    const imports = new Bun.Transpiler({ loader }).scanImports(source)
    for (const item of imports) {
      const specifier = item.path
      if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:") || specifier.startsWith("bun:") || builtins.has(specifier)) continue
      findings.push(`${relative(root, path)}: ${specifier}`)
    }
  }
}

scan(root)

if (findings.length > 0) {
  console.error("Skill scripts must run without package auto-install:")
  for (const finding of findings) console.error(`  ${finding}`)
  process.exit(1)
}

console.log("Skill scripts have no external package imports")
