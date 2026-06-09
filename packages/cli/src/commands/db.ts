import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { parseArgs } from "../lib/args.js"
import { writeSchemaManifest } from "../lib/schema-manifest.js"
import { loadVoyantConfig } from "../lib/voyant-config.js"
import type { CommandContext, CommandResult } from "../types.js"
import { dbDoctorCommand } from "./db-doctor.js"
import { dbSchemasCommand } from "./db-schemas.js"
import { dbSyncLinksCommand } from "./db-sync-links.js"

/**
 * `voyant db <subcommand>` — proxy drizzle-kit operations to the nearest
 * template package that owns a `drizzle.config.ts`, plus Voyant-specific
 * database helpers that don't map 1:1 onto drizzle-kit.
 *
 * Drizzle-kit proxies: `generate`, `migrate`, `studio`, `push`, `check`.
 * Additional arguments are forwarded verbatim.
 *
 * Voyant helpers:
 * - `sync-links` — emit DDL for cross-module link tables from a template's
 *   `links` array (see {@link dbSyncLinksCommand}).
 *
 * Resolution order for drizzle-kit proxies (first hit wins): `--template
 * <path>`, `templates/dmc`, or the current working directory.
 */
export async function dbCommand(ctx: CommandContext): Promise<CommandResult> {
  const { positionals, flags } = parseArgs(ctx.argv)
  const [sub, ...rest] = positionals
  if (!sub) {
    ctx.stderr(
      "Usage: voyant db <generate|migrate|studio|push|check|sync-links|schemas|doctor> [...args]\n",
    )
    return 1
  }

  // Voyant-specific helpers — do not proxy to drizzle-kit.
  if (sub === "sync-links") {
    const idx = ctx.argv.indexOf(sub)
    const subArgs = idx >= 0 ? ctx.argv.slice(idx + 1) : []
    return dbSyncLinksCommand({ ...ctx, argv: subArgs })
  }
  if (sub === "schemas") {
    const idx = ctx.argv.indexOf(sub)
    const subArgs = idx >= 0 ? ctx.argv.slice(idx + 1) : []
    return dbSchemasCommand({ ...ctx, argv: subArgs })
  }
  if (sub === "doctor") {
    const idx = ctx.argv.indexOf(sub)
    const subArgs = idx >= 0 ? ctx.argv.slice(idx + 1) : []
    return dbDoctorCommand({ ...ctx, argv: subArgs })
  }

  const known = new Set(["generate", "migrate", "studio", "push", "check"])
  if (!known.has(sub)) {
    ctx.stderr(`Unknown drizzle-kit subcommand: ${sub}\n`)
    return 1
  }

  const templateDir = resolveTemplateDir(ctx.cwd, flags.template)
  if (!templateDir) {
    ctx.stderr(
      "Could not find a template with drizzle.config.ts. " +
        "Run this command from the repo root, or pass --template <path>.\n",
    )
    return 1
  }

  // Keep the committed schema manifest fresh before generating a migration so
  // drizzle-kit always sees the manifest-derived schema set.
  if (sub === "generate") {
    const config = await loadVoyantConfig(templateDir, null)
    if (config) {
      const generated = writeSchemaManifest(config, { cwd: templateDir })
      ctx.stdout(`Wrote ${generated.entries.length} schema entrypoint(s) to ${generated.path}\n`)
    }
  }

  const args = ["drizzle-kit", sub, ...rest]
  ctx.stdout(`> pnpm -C ${templateDir} ${args.join(" ")}\n`)

  return new Promise((resolve) => {
    const child = spawn("pnpm", ["-C", templateDir, ...args], {
      stdio: "inherit",
      shell: false,
    })
    child.on("exit", (code) => resolve(code ?? 0))
    child.on("error", (err) => {
      ctx.stderr(`Failed to spawn pnpm: ${err.message}\n`)
      resolve(1)
    })
  })
}

function resolveTemplateDir(cwd: string, override: string | boolean | undefined): string | null {
  if (typeof override === "string") {
    return existsSync(join(override, "drizzle.config.ts")) ? override : null
  }
  if (existsSync(join(cwd, "drizzle.config.ts"))) return cwd
  return null
}
