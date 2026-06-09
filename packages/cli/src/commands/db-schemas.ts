import { parseArgs } from "../lib/args.js"
import {
  defaultLinkSchemaEntry,
  materializedLinks,
  writeLinkSchemaManifest,
} from "../lib/link-schema-manifest.js"
import { loadVoyantConfig } from "../lib/load-voyant-config.js"
import type { SchemaResolutionStyle } from "../lib/resolve-schemas.js"
import { resolveSchemaManifest, writeSchemaManifest } from "../lib/schema-manifest.js"
import type { CommandContext, CommandResult } from "../types.js"
import { loadLinks, resolveLinksPath } from "./db-sync-links.js"

/**
 * `voyant db schemas` — print the schema entrypoints derived from
 * `voyant.config.ts` (or whichever config the CLI's config-loader picks up).
 *
 * Useful for debugging the dependency closure used by drizzle-kit. Defaults
 * to "specifier" output; pass `--style=file` to resolve each entry to an
 * absolute file path. Pass `--emit` to write `drizzle.schemas.generated.ts`.
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

  let additionalSchemas: string[] = []
  const linksPath = resolveLinksPath(ctx.cwd, flags)
  if (linksPath) {
    let links: Awaited<ReturnType<typeof loadLinks>>
    try {
      links = await loadLinks(linksPath)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      ctx.stderr(`Failed to load links from ${linksPath}: ${reason}\n`)
      return 1
    }

    if (materializedLinks(links).length > 0) {
      additionalSchemas = [defaultLinkSchemaEntry()]
      if (flags.emit === true) {
        const generatedLinks = writeLinkSchemaManifest(links, {
          cwd: ctx.cwd,
          sourcePath: linksPath,
        })
        ctx.stdout(
          `Wrote ${generatedLinks.links.length} link table schema(s) to ${generatedLinks.path}\n`,
        )
      }
    }
  }

  const schemas = resolveSchemaManifest(config, { cwd: ctx.cwd, style, additionalSchemas })
  if (flags.emit === true) {
    const out = typeof flags.out === "string" ? flags.out : undefined
    const generated = writeSchemaManifest(config, {
      cwd: ctx.cwd,
      outPath: out,
      additionalSchemas,
    })
    ctx.stdout(`Wrote ${generated.entries.length} schema entrypoint(s) to ${generated.path}\n`)
  }
  for (const entry of schemas) {
    ctx.stdout(`${entry}\n`)
  }
  return 0
}
