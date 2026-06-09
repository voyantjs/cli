import { existsSync } from "node:fs"
import { isAbsolute, join, resolve as resolvePath } from "node:path"
import { pathToFileURL } from "node:url"

import type { VoyantConfig } from "@voyantjs/core/config"

/**
 * Locate and dynamically import a `voyant.config.{ts,js,mjs}` from `cwd` or
 * the explicit `override` path. Returns `null` when no config is found so the
 * caller can surface a command-specific usage error.
 */
export async function loadVoyantConfig(
  cwd: string,
  override: string | null,
): Promise<VoyantConfig | null> {
  const candidates = override
    ? [isAbsolute(override) ? override : resolvePath(cwd, override)]
    : ["voyant.config.ts", "voyant.config.js", "voyant.config.mjs"].map((name) => join(cwd, name))

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const mod = await import(pathToFileURL(candidate).href)
    const config = (mod.default ?? mod) as VoyantConfig
    return config
  }
  return null
}
