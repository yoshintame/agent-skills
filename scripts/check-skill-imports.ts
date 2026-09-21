import { existsSync, readdirSync, readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, extname, join, relative } from "node:path"

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
const manifests = new Set<string>()

function manifestFor(path: string): string | null {
  for (let dir = dirname(path); dir !== root; dir = dirname(dir)) {
    const manifest = join(dir, "package.json")
    if (existsSync(manifest)) return manifest
  }
  return null
}

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
      const manifest = manifestFor(path)
      if (!manifest) {
        findings.push(`${relative(root, path)}: ${specifier} has no package.json`)
        continue
      }
      manifests.add(manifest)
      const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]
      const packageJson = JSON.parse(readFileSync(manifest, "utf8")) as { dependencies?: Record<string, string> }
      if (!packageJson.dependencies?.[packageName]) findings.push(`${relative(root, path)}: ${specifier} is not a runtime dependency of ${relative(root, manifest)}`)
      if (!existsSync(join(dirname(manifest), "bun.lock"))) findings.push(`${relative(root, manifest)} has no bun.lock`)
    }
  }
}

scan(root)

for (const manifest of manifests) {
  const result = Bun.spawnSync(["bun", "install", "--frozen-lockfile", "--dry-run", "--cwd", dirname(manifest)], {
    stdout: "ignore",
    stderr: "pipe",
  })
  if (!result.success) findings.push(`${relative(root, manifest)}: lockfile does not match package.json`)
}

if (findings.length > 0) {
  console.error("Skill script dependencies must be declared and locked beside the scripts:")
  for (const finding of findings) console.error(`  ${finding}`)
  process.exit(1)
}

console.log("Skill script imports have local manifests and lockfiles")
