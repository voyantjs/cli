import { existsSync } from "node:fs"
import { isAbsolute, join, resolve as resolvePath } from "node:path"
import { pathToFileURL } from "node:url"

import type { VoyantConfig } from "@voyantjs/core/config"

import { parseArgs } from "../lib/args.js"
import { resolveSchemas, type SchemaResolutionStyle } from "../lib/resolve-schemas.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * `voyant db schemas` — print the schema entrypoints derived from
 * `voyant.config.ts` (or whichever config the CLI's config-loader picks up).
 *
 * Useful for debugging the dependency closure used by drizzle-kit. Defaults
 * to "specifier" output; pass `--style=file` to resolve each entry to an
 * absolute file path.
 */
export async function dbSchemasCommand(ctx: CommandContext): Promise<CommandResult> {
  const { flags } = parseArgs(ctx.argv)

  const configPath = typeof flags.config === "string" ? flags.config : null
  const style = (
    typeof flags.style === "string" ? flags.style : "specifier"
  ) as SchemaResolutionStyle

  if (style !== "specifier" && style !== "file") {
    ctx.stderr(`Invalid --style: ${style}. Expected "specifier" or "file".\n`)
    return 1
  }

  const config = await loadVoyantConfig(ctx.cwd, configPath)
  if (!config) {
    ctx.stderr(
      "Could not locate a voyant.config.ts. Run from a directory containing one or pass --config <path>.\n",
    )
    return 1
  }

  const schemas = resolveSchemas(config, { cwd: ctx.cwd, style })
  for (const entry of schemas) {
    ctx.stdout(`${entry}\n`)
  }
  return 0
}

/**
 * Locate and dynamically import a `voyant.config.{ts,js,mjs}` from `cwd` or
 * the explicit `override` path. Returns `null` when no config is found so the
 * caller can surface a usage error.
 */
async function loadVoyantConfig(
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
