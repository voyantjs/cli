import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

import type { VoyantConfig } from "@voyantjs/core/config"

import {
  type AdminEntryScanResult,
  DEFAULT_GENERATED_RELATIVE_PATH,
  scanAdminEntries,
} from "../lib/admin-entries.js"
import {
  type AdminRouteRuntimeImports,
  alternativeRouteFileRelPaths,
  canonicalRouteFileRelPath,
  DEFAULT_ROUTE_RUNTIME_IMPORTS,
  DEFAULT_ROUTES_DIR,
  fileRouteIdFor,
  isGeneratedRouteFile,
  renderRouteFile,
  scanRouteContributions,
} from "../lib/admin-routes.js"
import { getBooleanFlag, getStringFlag, parseArgs } from "../lib/args.js"
import { loadVoyantConfigFile, resolveConfigPath } from "../lib/config-loader.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * `voyant admin generate [--config <path>] [--out <file>] [--check]`
 *
 * Manifest-driven admin composition (packaged-admin RFC §4.1): for every
 * module in voyant.config.*, derive its `<module>-ui/admin` entry (or the
 * module's `package.json#voyant.adminEntry` override), verify the entry via
 * package.json inspection only, and emit a committed file of static imports:
 *
 * ```ts
 * import { createPromotionsAdminExtension } from "@voyantjs/promotions-ui/admin"
 * export const generatedAdminExtensionFactories = { ... } as const
 * ```
 *
 * Factories — not instances — so hosts can pass localized labels/icons.
 *
 * `voyant admin generate --routes [--routes-dir <dir>] [--check]`
 *
 * Generated thin route files (packaged-admin RFC §4.2, first increment of
 * code-based route assembly): statically scan each admin entry's route
 * contributions and emit one thin host file per ZERO-PROP route (component
 * present, no `$param` segments) into the host's file-based route tree.
 * Param-taking detail hosts stay hand-written. A file without the generated
 * header is never overwritten — deleting the header is how a host ejects a
 * route. Runtime-import bindings default to the operator conventions
 * (`@/lib/env` / `@/lib/voyant-fetcher`) and are configurable via the
 * manifest's `admin.routes` block.
 *
 * `--check` writes nothing and exits 1 when committed output is missing or
 * differs from what would be generated (CI drift gate).
 */
export async function adminGenerateCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const configFlag = getStringFlag(args, "config")
  const outFlag = getStringFlag(args, "out")
  const check = getBooleanFlag(args, "check")
  const routesMode = getBooleanFlag(args, "routes")

  const configPath = resolveConfigPath({ path: configFlag, cwd: ctx.cwd })
  if (!configPath) {
    ctx.stderr(
      configFlag
        ? `No voyant config found at ${configFlag}\n`
        : `No voyant.config.* found in ${ctx.cwd} or any parent directory.\n`,
    )
    return 1
  }

  let config: VoyantConfig
  try {
    const loaded = await loadVoyantConfigFile<VoyantConfig>(configPath)
    config = loaded.config
  } catch (err) {
    ctx.stderr(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  const configDir = dirname(configPath)
  const modules = config.modules ?? []
  const results = scanAdminEntries(modules, configDir)

  if (routesMode) {
    return generateRouteFiles({
      ctx,
      config,
      configDir,
      results,
      check,
      routesDirFlag: getStringFlag(args, "routes-dir"),
    })
  }

  for (const result of results) {
    if (result.status === "found" && !result.note) continue
    ctx.stderr(`[admin-generate] ${describeResult(result)}\n`)
  }

  const found = results.filter((result) => result.status === "found")
  const content = renderGeneratedFile(found)

  const outPath = outFlag
    ? isAbsolute(outFlag)
      ? outFlag
      : resolve(ctx.cwd, outFlag)
    : join(configDir, DEFAULT_GENERATED_RELATIVE_PATH)
  const printablePath = relative(ctx.cwd, outPath) || outPath

  if (check) {
    const existing = existsSync(outPath) ? readFileSync(outPath, "utf8") : null
    if (existing === content) {
      ctx.stdout(
        `[admin-generate] ${modules.length} modules, ${found.length} admin entries, ${printablePath} is up to date\n`,
      )
      return 0
    }
    ctx.stderr(
      existing === null
        ? `[admin-generate] ${printablePath} is missing — run \`voyant admin generate\`\n`
        : `[admin-generate] ${printablePath} is out of date — run \`voyant admin generate\`\n`,
    )
    return 1
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, content)
  ctx.stdout(
    `[admin-generate] ${modules.length} modules, ${found.length} admin entries, wrote ${printablePath}\n`,
  )
  return 0
}

function describeResult(result: AdminEntryScanResult): string {
  switch (result.status) {
    case "found":
      return `note: ${result.moduleName} — ${result.note}`
    case "missing-export":
      return `warning: skipped ${result.moduleName} — ${result.note}`
    case "module-unresolved":
    case "not-a-package":
      return `note: skipped ${result.moduleName} — ${result.note}`
    default:
      return `note: ${result.moduleName} — ${result.note} (no admin entry)`
  }
}

/**
 * Render the committed composition file. Deterministic output (manifest
 * order) so `--check` is a pure string comparison.
 */
export function renderGeneratedFile(found: ReadonlyArray<AdminEntryScanResult>): string {
  const header = [
    "// GENERATED by voyant admin generate — do not edit.",
    "// Recreate after changing the modules list in voyant.config.*:",
    "//   voyant admin generate",
    "",
  ]

  const imports = found.map((entry) => `import { ${entry.exportName} } from "${entry.importSpec}"`)

  const body = [
    "/**",
    " * Admin extension factories keyed by module domain. Factories, not",
    " * instances — hosts call each with localized labels/icons before",
    " * registering the result.",
    " */",
    "export const generatedAdminExtensionFactories = {",
    ...found.map((entry) => `  ${entry.camel}: ${entry.exportName},`),
    "} as const",
    "",
  ]

  return [...header, ...(imports.length > 0 ? [...imports, ""] : []), ...body].join("\n")
}

/** Manifest `admin.routes` block, read structurally (older core types lack it). */
function readAdminRoutesConfig(config: VoyantConfig): {
  dir?: string
  runtime: AdminRouteRuntimeImports
} {
  const routes = (
    config as {
      admin?: {
        routes?: {
          dir?: string
          apiUrlModule?: string
          apiUrlExport?: string
          fetcherModule?: string
          fetcherExport?: string
        }
      }
    }
  ).admin?.routes
  return {
    dir: typeof routes?.dir === "string" ? routes.dir : undefined,
    runtime: {
      apiUrlModule: routes?.apiUrlModule ?? DEFAULT_ROUTE_RUNTIME_IMPORTS.apiUrlModule,
      apiUrlExport: routes?.apiUrlExport ?? DEFAULT_ROUTE_RUNTIME_IMPORTS.apiUrlExport,
      fetcherModule: routes?.fetcherModule ?? DEFAULT_ROUTE_RUNTIME_IMPORTS.fetcherModule,
      fetcherExport: routes?.fetcherExport ?? DEFAULT_ROUTE_RUNTIME_IMPORTS.fetcherExport,
    },
  }
}

interface GenerateRouteFilesOptions {
  ctx: CommandContext
  config: VoyantConfig
  configDir: string
  results: ReadonlyArray<AdminEntryScanResult>
  check: boolean
  routesDirFlag: string | undefined
}

/**
 * `voyant admin generate --routes` — emit generated thin route files for
 * every zero-prop route contribution of every resolved admin entry.
 *
 * Per contribution:
 * - no statically resolvable id/path → note, skipped (the generator only
 *   trusts what it can read without executing the entry)
 * - path contains `$param` segments → skipped, hand-written hosts bind params
 * - no `component` → skipped, metadata-only contribution
 * - an existing file WITHOUT the generated header → skipped and reported:
 *   that file is ejected (hand-written), and stays the host's own
 * - otherwise → written (or, with `--check`, compared for drift)
 */
function generateRouteFiles(options: GenerateRouteFilesOptions): CommandResult {
  const { ctx, config, configDir, results, check } = options
  const routesConfig = readAdminRoutesConfig(config)
  const routesDirRel = options.routesDirFlag ?? routesConfig.dir ?? DEFAULT_ROUTES_DIR
  const routesDir = isAbsolute(routesDirRel) ? routesDirRel : join(configDir, routesDirRel)

  let eligible = 0
  let written = 0
  let upToDate = 0
  let ejected = 0
  let paramSkipped = 0
  let metadataOnly = 0
  let drift = 0

  const found = results.filter(
    (result): result is AdminEntryScanResult & { importSpec: string; sourcePath: string } =>
      result.status === "found" &&
      result.importSpec !== undefined &&
      result.sourcePath !== undefined,
  )

  for (const entry of found) {
    let source: string
    try {
      source = readFileSync(entry.sourcePath, "utf8")
    } catch {
      ctx.stderr(`[admin-generate] routes: note — ${entry.importSpec} source not readable\n`)
      continue
    }

    for (const contribution of scanRouteContributions(source)) {
      if (contribution.id === null || contribution.path === null) {
        ctx.stderr(
          `[admin-generate] routes: note — skipped a ${entry.importSpec} contribution ` +
            `(id/path not statically resolvable${
              contribution.rawPath === null ? "" : `: path ${contribution.rawPath}`
            })\n`,
        )
        continue
      }
      if (contribution.path.includes("$")) {
        paramSkipped++
        continue
      }
      if (!contribution.hasComponent) {
        metadataOnly++
        continue
      }

      eligible++
      const canonicalRel = canonicalRouteFileRelPath(contribution.path)
      const canonicalPath = join(routesDir, canonicalRel)
      const printable = relative(ctx.cwd, canonicalPath) || canonicalPath

      const handWritten = alternativeRouteFileRelPaths(contribution.path)
        .map((rel) => join(routesDir, rel))
        .find((candidate) => existsSync(candidate))
      const existing = existsSync(canonicalPath) ? readFileSync(canonicalPath, "utf8") : null

      if (existing !== null && !isGeneratedRouteFile(existing)) {
        ejected++
        ctx.stderr(
          `[admin-generate] routes: skipped ${contribution.path} — ${printable} has no ` +
            `generated header (ejected, hand-written host)\n`,
        )
        continue
      }
      if (existing === null && handWritten !== undefined) {
        ejected++
        const printableHandWritten = relative(ctx.cwd, handWritten) || handWritten
        ctx.stderr(
          `[admin-generate] routes: skipped ${contribution.path} — hand-written host ` +
            `${printableHandWritten} already binds this route\n`,
        )
        continue
      }

      const content = renderRouteFile({
        fileRouteId: fileRouteIdFor(routesDirRel, contribution.path),
        importSpec: entry.importSpec,
        exportName: entry.exportName,
        routeId: contribution.id,
        ssr: contribution.ssr,
        preload: contribution.preload,
        hasLoader: contribution.hasLoader,
        hasValidateSearch: contribution.hasValidateSearch,
        runtime: routesConfig.runtime,
      })

      if (existing === content) {
        upToDate++
        continue
      }
      if (check) {
        drift++
        ctx.stderr(
          existing === null
            ? `[admin-generate] routes: ${printable} is missing — run \`voyant admin generate --routes\`\n`
            : `[admin-generate] routes: ${printable} is out of date — run \`voyant admin generate --routes\`\n`,
        )
        continue
      }
      mkdirSync(dirname(canonicalPath), { recursive: true })
      writeFileSync(canonicalPath, content)
      written++
      ctx.stdout(
        `[admin-generate] routes: wrote ${printable} (${entry.importSpec} ${contribution.id})\n`,
      )
    }
  }

  ctx.stdout(
    `[admin-generate] routes: ${eligible} zero-prop route(s) across ${found.length} admin ` +
      `entries — ${check ? `${upToDate} up to date, ${drift} drifted` : `${written} written, ${upToDate} up to date`}, ` +
      `${ejected} ejected, ${paramSkipped} param route(s) and ${metadataOnly} metadata-only ` +
      `contribution(s) left to hand-written hosts\n`,
  )
  return check && drift > 0 ? 1 : 0
}
