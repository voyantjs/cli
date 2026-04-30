// Dynamic loader for a user's workflow entry file. When given a TS
// source, it bundles to a temporary CommonJS artifact first so
// top-level `workflow(...)` registrations can run under plain Node.

import { mkdir } from "node:fs/promises"
import { basename, extname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

export interface EntryFile {
  /** Module exports, for surfacing named workflows the user may expose. */
  exports: Record<string, unknown>
}

export interface LoadEntryOptions {
  /**
   * Append a cache-busting query so Node's ESM loader re-evaluates
   * the module. Needed by watch-mode reloaders (e.g. `voyant dev`);
   * harmless for one-shot commands.
   */
  cacheBust?: boolean
}

export async function loadEntryFile(
  path: string,
  options: LoadEntryOptions = {},
): Promise<EntryFile> {
  const absolute = resolve(process.cwd(), path)
  const importPath = await resolveImportPath(absolute, options)
  const baseUrl = pathToFileURL(importPath).href
  const url = options.cacheBust ? `${baseUrl}?t=${Date.now()}` : baseUrl
  try {
    const mod = (await import(url)) as Record<string, unknown>
    return { exports: mod }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      `voyant: failed to load entry file ${path}: ${message}\n` +
        `Hint: pass a compiled .js / .mjs file, or run \`voyant workflows build\` / ` +
        `\`voyant dev\` on a .ts source to bundle with esbuild first.`,
    )
  }
}

async function resolveImportPath(path: string, options: LoadEntryOptions): Promise<string> {
  if (!shouldBundleSource(path)) {
    return path
  }

  const outDir = resolve(process.cwd(), ".voyant", "entry-load")
  await mkdir(outDir, { recursive: true })

  const suffix = options.cacheBust ? `${Date.now()}` : "stable"
  const outFile = join(outDir, `${sanitizeBaseName(path)}-${suffix}.cjs`)
  const { build } = await import("esbuild")

  await build({
    entryPoints: [path],
    outfile: outFile,
    bundle: true,
    format: "cjs",
    target: "es2022",
    platform: "node",
    logLevel: "silent",
    sourcemap: false,
  })

  return outFile
}

function shouldBundleSource(path: string): boolean {
  return [".ts", ".tsx", ".mts", ".cts"].includes(extname(path))
}

function sanitizeBaseName(path: string): string {
  return basename(path).replace(/[^a-zA-Z0-9._-]/g, "-")
}
