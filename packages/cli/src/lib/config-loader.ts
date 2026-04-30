import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

/**
 * Supported config file names, in the order we probe them.
 */
export const CONFIG_FILENAMES = [
  "voyant.config.ts",
  "voyant.config.mts",
  "voyant.config.mjs",
  "voyant.config.js",
  "voyant.config.cjs",
] as const

export interface ResolveConfigOptions {
  /** Explicit path override (accepts absolute or relative-to-cwd). */
  path?: string
  /** Starting directory; defaults to `process.cwd()`. */
  cwd?: string
  /**
   * When true (the default), walk parent directories until a config file
   * is found or the filesystem root is reached.
   */
  walkUp?: boolean
}

/**
 * Locate the nearest voyant.config.* file relative to `cwd` (or a caller-
 * provided absolute path).
 *
 * Returns null when nothing was found — callers decide whether that's an
 * error (e.g. `voyant config` command) or a silent no-op (e.g. `voyant
 * generate module` without a manifest).
 */
export function resolveConfigPath(opts: ResolveConfigOptions = {}): string | null {
  const cwd = opts.cwd ?? process.cwd()

  if (opts.path) {
    const abs = isAbsolute(opts.path) ? opts.path : resolve(cwd, opts.path)
    return existsSync(abs) ? abs : null
  }

  const walkUp = opts.walkUp ?? true
  let current = cwd
  while (true) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(current, name)
      if (existsSync(candidate)) return candidate
    }
    if (!walkUp) return null
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * A loaded voyant config plus the absolute path it came from.
 */
export interface LoadedConfig<T = unknown> {
  /** Absolute path to the resolved config file. */
  path: string
  /** The manifest object exported from the config file. */
  config: T
}

/**
 * Dynamically import a voyant config file and return its default export.
 *
 * The CLI has zero runtime deps, so we rely on the platform:
 * - `.js`, `.mjs`, `.cjs` are dynamic-importable in all Node versions.
 * - `.ts`, `.mts` rely on Node's native TypeScript support
 *   (`--experimental-strip-types`, stable in Node 22.6+).
 *
 * Throws if the file cannot be imported or does not have a default export.
 */
export async function loadVoyantConfigFile<T = unknown>(absPath: string): Promise<LoadedConfig<T>> {
  const href = pathToFileURL(absPath).href
  let imported: unknown
  try {
    imported = await import(href)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to load voyant config at ${absPath}: ${reason}`)
  }

  const mod = imported as { default?: unknown }
  if (mod.default === undefined) {
    throw new Error(
      `voyant config at ${absPath} has no default export. Export the result of defineVoyantConfig() as the default.`,
    )
  }

  return { path: absPath, config: mod.default as T }
}
