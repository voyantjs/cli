import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { isAbsolute, join, resolve as resolvePath } from "node:path"

import { parseArgs } from "../lib/args.js"
import {
  defaultLinkSchemaEntry,
  materializedLinks,
  writeLinkSchemaManifest,
} from "../lib/link-schema-manifest.js"
import { loadVoyantConfig } from "../lib/load-voyant-config.js"
import { writeSchemaManifest } from "../lib/schema-manifest.js"
import type { CommandContext, CommandResult } from "../types.js"
import { dbDoctorCommand } from "./db-doctor.js"
import { dbSchemasCommand } from "./db-schemas.js"
import { dbSyncLinksCommand, loadLinks, resolveLinksPath } from "./db-sync-links.js"

/**
 * `voyant db <subcommand>` — proxy drizzle-kit operations to the nearest
 * template package that owns a `drizzle.config.ts`, plus Voyant-specific
 * database helpers that don't map 1:1 onto drizzle-kit.
 *
 * Drizzle-kit proxies: `generate`, `migrate`, `studio`, `push`, `check`.
 * Drizzle arguments are forwarded after consuming Voyant's own `--template`
 * selector. `generate` defaults to `--prefix timestamp` unless the caller
 * supplies an explicit `--prefix`.
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
  const [sub] = positionals
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

  if (sub === "generate") {
    const config = await loadVoyantConfig(templateDir, null)
    if (config) {
      let additionalSchemas: string[] = []
      const linksPath = resolveLinksPath(templateDir, {})
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
          const generatedLinks = writeLinkSchemaManifest(links, {
            cwd: templateDir,
            sourcePath: linksPath,
          })
          ctx.stdout(
            `Wrote ${generatedLinks.links.length} link table schema(s) to ${generatedLinks.path}\n`,
          )
          additionalSchemas = [defaultLinkSchemaEntry()]
        }
      }

      const generated = writeSchemaManifest(config, { cwd: templateDir, additionalSchemas })
      ctx.stdout(`Wrote ${generated.entries.length} schema entrypoint(s) to ${generated.path}\n`)
    }
  }

  const proxy = buildDrizzleProxyCommand(templateDir, sub, rawSubcommandArgs(ctx.argv, sub))
  ctx.stdout(`> pnpm ${proxy.pnpmArgs.join(" ")}\n`)

  return new Promise((resolve) => {
    const child = spawn("pnpm", proxy.pnpmArgs, {
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

export interface DrizzleProxyCommand {
  pnpmArgs: string[]
  drizzleArgs: string[]
}

export function buildDrizzleProxyCommand(
  templateDir: string,
  subcommand: string,
  rawArgs: ReadonlyArray<string>,
): DrizzleProxyCommand {
  const forwardedArgs = withGeneratePrefixDefault(
    subcommand,
    stripVoyantDbFlags(Array.from(rawArgs)),
  )
  const drizzleArgs = ["drizzle-kit", subcommand, ...forwardedArgs]
  return {
    pnpmArgs: ["--dir", templateDir, "exec", ...drizzleArgs],
    drizzleArgs,
  }
}

function resolveTemplateDir(cwd: string, override: string | boolean | undefined): string | null {
  if (typeof override === "string") {
    const target = isAbsolute(override) ? override : resolvePath(cwd, override)
    return existsSync(join(target, "drizzle.config.ts")) ? target : null
  }
  if (existsSync(join(cwd, "drizzle.config.ts"))) return cwd
  const defaultTemplate = join(cwd, "templates/dmc")
  if (existsSync(join(defaultTemplate, "drizzle.config.ts"))) return defaultTemplate
  return null
}

function rawSubcommandArgs(argv: ReadonlyArray<string>, subcommand: string): string[] {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === subcommand) return Array.from(argv.slice(i + 1))
    if (!token?.startsWith("--") || token.includes("=")) continue

    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith("-")) i++
  }
  return []
}

function stripVoyantDbFlags(args: string[]): string[] {
  const forwarded: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--template") {
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith("-")) i++
      continue
    }
    if (arg?.startsWith("--template=")) continue
    if (arg !== undefined) forwarded.push(arg)
  }
  return forwarded
}

function withGeneratePrefixDefault(subcommand: string, args: string[]): string[] {
  if (subcommand !== "generate" || hasPrefixFlag(args)) return args
  return [...args, "--prefix", "timestamp"]
}

function hasPrefixFlag(args: ReadonlyArray<string>): boolean {
  return args.some((arg) => arg === "--prefix" || arg.startsWith("--prefix="))
}
