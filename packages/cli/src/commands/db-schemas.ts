import { parseArgs } from "../lib/args.js"
import type { SchemaResolutionStyle } from "../lib/resolve-schemas.js"
import { resolveSchemaManifest, writeSchemaManifest } from "../lib/schema-manifest.js"
import { loadVoyantConfig } from "../lib/voyant-config.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * `voyant db schemas [--style=specifier|file] [--config <path>] [--emit [--out <file>]]`
 *
 * Print the schema entrypoints derived from `voyant.config.ts` — the
 * dependency closure of `modules` + `additionalSchemas`, followed by any
 * template-local `schemas`. Defaults to "specifier" output; pass
 * `--style=file` for absolute paths.
 *
 * Pass `--emit` to also write the committed `drizzle.schemas.generated.ts`
 * (optionally to `--out <file>`) that a template's `drizzle.config.ts` can
 * import instead of hand-listing schema paths.
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

  if (flags.emit === true) {
    const out = typeof flags.out === "string" ? flags.out : undefined
    const generated = writeSchemaManifest(config, { cwd: ctx.cwd, outPath: out })
    ctx.stdout(`Wrote ${generated.entries.length} schema entrypoint(s) to ${generated.path}\n`)
  }

  const schemas = resolveSchemaManifest(config, { cwd: ctx.cwd, style })
  for (const entry of schemas) {
    ctx.stdout(`${entry}\n`)
  }
  return 0
}
