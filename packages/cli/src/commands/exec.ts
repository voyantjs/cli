import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { parseArgs } from "../lib/args.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * Loader hook (same as db-sync-links) that rewrites NodeNext-style `.js`
 * specifiers to the matching `.ts` source, plus extensionless
 * bundler-style imports (try `.ts`/`.mts`/`.tsx` + `/index.*`).
 *
 * Emitted as a data: URL so we can ship it without touching the
 * filesystem.
 */
const LOADER_HOOK_SRC = `
import { existsSync, statSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
function tryResolveTs(specifier, parentDir) {
  if (specifier.endsWith(".js") || specifier.endsWith(".mjs") || specifier.endsWith(".cjs")) {
    const ext = specifier.endsWith(".mjs") ? ".mjs" : specifier.endsWith(".cjs") ? ".cjs" : ".js"
    const tsExt = ext === ".mjs" ? ".mts" : ext === ".cjs" ? ".cts" : ".ts"
    const candidate = parentDir + "/" + specifier.slice(0, -ext.length) + tsExt
    if (existsSync(candidate)) return candidate
    return null
  }
  const base = parentDir + "/" + specifier
  for (const ext of [".ts", ".mts", ".tsx"]) {
    if (existsSync(base + ext)) return base + ext
  }
  try {
    if (statSync(base).isDirectory()) {
      for (const idx of ["/index.ts", "/index.mts", "/index.tsx"]) {
        if (existsSync(base + idx)) return base + idx
      }
    }
  } catch {}
  return null
}
export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
    const parentPath = fileURLToPath(context.parentURL)
    const lastSlash = parentPath.lastIndexOf("/")
    const parentDir = lastSlash >= 0 ? parentPath.slice(0, lastSlash) : parentPath
    const found = tryResolveTs(specifier, parentDir)
    if (found) return nextResolve(pathToFileURL(found).href, context)
  }
  return nextResolve(specifier, context)
}
`

const REGISTER_HOOK_SRC =
  `import { register } from "node:module";` +
  `register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(LOADER_HOOK_SRC)}`)},` +
  ` import.meta.url);`

/**
 * `voyant exec <script> [args...]`
 *
 * Run a TypeScript/JavaScript script inside a Node subprocess with
 * `--experimental-strip-types --experimental-transform-types` + the
 * voyant loader hook (so bundler-style and `.js`→`.ts` imports work
 * out of the box).
 *
 * The script receives `args` via `process.argv` starting at position 2
 * (standard Node behavior). Stdout/stderr are inherited, so the
 * script can log freely and its exit code propagates.
 *
 * Use this for:
 * - one-off migrations or data tasks
 * - exercising workspace code without bundling
 * - reproducing test cases that hit real module code paths
 */
export async function execCommand(ctx: CommandContext): Promise<CommandResult> {
  const { positionals } = parseArgs(ctx.argv)
  const [scriptRef, ...scriptArgs] = positionals
  if (!scriptRef) {
    ctx.stderr("Usage: voyant exec <script.ts|script.js> [args...]\n")
    return 1
  }

  const abs = isAbsolute(scriptRef) ? scriptRef : resolve(ctx.cwd, scriptRef)
  if (!existsSync(abs)) {
    ctx.stderr(`Script not found: ${abs}\n`)
    return 1
  }

  const href = pathToFileURL(abs).href
  // Use a tiny launcher that dynamic-imports the script after the hook
  // has been registered. This ensures the hook applies to the script's
  // own imports too.
  const launcher =
    `import(${JSON.stringify(href)}).catch((e)=>{` +
    `process.stderr.write((e?.stack??String(e))+"\\n");` +
    `process.exit(1);` +
    `});`

  const importHookUrl = `data:text/javascript,${encodeURIComponent(REGISTER_HOOK_SRC)}`
  const args = [
    "--experimental-strip-types",
    "--experimental-transform-types",
    "--no-warnings",
    `--import=${importHookUrl}`,
    "--input-type=module",
    "-e",
    launcher,
    "--",
    ...scriptArgs,
  ]

  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", cwd: ctx.cwd })
    child.on("error", (err) => {
      ctx.stderr(`Failed to spawn node: ${err.message}\n`)
      resolvePromise(1)
    })
    child.on("exit", (code) => resolvePromise(code ?? 0))
  })
}
