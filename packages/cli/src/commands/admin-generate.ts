import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

import type { VoyantConfig } from "@voyantjs/core/config"

import {
  type AdminEntryScanResult,
  DEFAULT_GENERATED_RELATIVE_PATH,
  scanAdminEntries,
} from "../lib/admin-entries.js"
import {
  type AdminRoutesManifestConfig,
  type AdminRoutesModuleRoute,
  type AdminRoutesModuleSection,
  alternativeRouteFileRelPaths,
  canonicalRouteFileRelPath,
  collectDestinationBindings,
  DEFAULT_GENERATED_DESTINATIONS_MODULE_RELATIVE_PATH,
  DEFAULT_GENERATED_ROUTES_MODULE_RELATIVE_PATH,
  DEFAULT_ROUTES_DIR,
  fileRouteIdFor,
  isGeneratedDestinationsFile,
  isGeneratedRouteFile,
  isImplementedContribution,
  renderAdminDestinationsModule,
  renderAdminRoutesModule,
  renderRouteFile,
  resolveAdminRoutesManifestConfig,
  resolveSearchSchemaIdent,
  routeIdPrefixFor,
  scanExtensionId,
  scanRouteContributions,
  workspaceRouteModuleFor,
} from "../lib/admin-routes.js"
import { getBooleanFlag, getStringFlag, parseArgs } from "../lib/args.js"
import { loadVoyantConfigFile, resolveConfigPath } from "../lib/config-loader.js"
import { toPascalCase } from "../lib/strings.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * `voyant admin generate [--config <path>] [--out <file>] [--check]`
 *
 * Manifest-driven admin composition (packaged-admin RFC §4.1): for every
 * module in voyant.config.*, derive its `<module>-react/admin` entry (or the
 * module's `package.json#voyant.adminEntry` override), verify the entry via
 * package.json inspection only, and emit a committed file of static imports:
 *
 * ```ts
 * import { createPromotionsAdminExtension } from "@voyantjs/promotions-react/admin"
 * export const generatedAdminExtensionFactories = { ... } as const
 * ```
 *
 * Factories — not instances — so hosts can pass localized labels/icons.
 *
 * `voyant admin generate --routes [--routes-dir <dir>] [--out <file>] [--check]`
 *
 * Code-assembled admin route module (packaged-admin RFC §4.8 endgame):
 * statically scan each admin entry's route contributions and emit ONE
 * committed module (default `src/admin.routes.generated.tsx`) holding a
 * code-based `createRoute` per implemented contribution (`page` or
 * `component` present — `$param` routes included), its options resolved from
 * the host-registered extension instances via `adminExtensionRouteOptions`,
 * plus the typed-link map interfaces the host's `router.tsx` merges. NO
 * per-route files exist for package-delivered pages. A target file without
 * the generated header is never overwritten — deleting the header is how a
 * host ejects the module; a hand-written route file binding a contribution's
 * path ejects that single route. Import bindings default to the operator
 * conventions (`@/lib/env`, `@/lib/voyant-fetcher`,
 * `@/lib/admin-extensions`) and are configurable via the manifest's
 * `admin.routes` block.
 *
 * `voyant admin generate --routes --files [--routes-dir <dir>] [--check]`
 *
 * Legacy per-route thin files (RFC §4.2 increment 1) for hosts not yet
 * migrated to the code-assembled module: one generated host file per
 * ZERO-PROP `component` route (no `$param` segments) under the host's
 * file-based route tree.
 *
 * `voyant admin generate --destinations [--out <file>] [--check]`
 *
 * Generated destination resolver map (packaged-admin RFC §4.7 endgame):
 * statically scan each admin entry's route contributions for `destination:`
 * annotations — the DECLARED bindings between a semantic destination key and
 * the one route whose path satisfies it by pure param interpolation — and
 * emit ONE committed module (default `src/admin.destinations.generated.ts`)
 * holding a typed resolver per binding (`encodeURIComponent` interpolation,
 * `destinationParams` name mapping), `satisfies
 * Partial<AdminDestinationResolvers>`. The host's resolver map shrinks to
 * `{ ...generatedAdminDestinations, ...custom } satisfies
 * AdminDestinationResolvers` — only genuinely custom resolvers (search-param
 * construction, multi-route targets) stay hand-written. A target file
 * without the generated header is never overwritten (ejected, host-owned).
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
    const routesOptions = {
      ctx,
      configDir,
      results,
      check,
      routesConfig: resolveAdminRoutesManifestConfig(config),
      routesDirFlag: getStringFlag(args, "routes-dir"),
    }
    return getBooleanFlag(args, "files")
      ? generateRouteFiles(routesOptions)
      : generateRoutesModule({ ...routesOptions, outFlag })
  }

  if (getBooleanFlag(args, "destinations")) {
    return generateDestinationsModule({ ctx, configDir, results, check, outFlag })
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

interface GenerateRouteFilesOptions {
  ctx: CommandContext
  configDir: string
  results: ReadonlyArray<AdminEntryScanResult>
  check: boolean
  routesConfig: AdminRoutesManifestConfig
  routesDirFlag: string | undefined
}

type FoundAdminEntry = AdminEntryScanResult & { importSpec: string; sourcePath: string }

function foundEntries(results: ReadonlyArray<AdminEntryScanResult>): FoundAdminEntry[] {
  return results.filter(
    (result): result is FoundAdminEntry =>
      result.status === "found" &&
      result.importSpec !== undefined &&
      result.sourcePath !== undefined,
  )
}

interface GenerateRoutesModuleOptions extends GenerateRouteFilesOptions {
  outFlag: string | undefined
}

/**
 * `voyant admin generate --routes` — emit the code-assembled admin route
 * module (packaged-admin RFC §4.8).
 *
 * Per contribution:
 * - no statically resolvable id/path → note, skipped (the generator only
 *   trusts what it can read without executing the entry)
 * - no implementation (`page`/`component`) → skipped, metadata-only — those
 *   stay bound by hand-written host route files
 * - a route file under the routes dir WITHOUT the generated header → that
 *   single route is ejected: omitted from the module and reported
 * - a leftover GENERATED thin route file (RFC §4.2 increment 1) → superseded
 *   by the module: deleted on write, reported as drift with `--check`
 * - `validateSearch` whose schema identifier cannot be statically resolved
 *   to an export of the entry → emitted without the typed search contract,
 *   noted (the runtime contract still applies via the contribution)
 *
 * A target module without the generated header is the host's own (ejected
 * wholesale) and is never overwritten.
 */
function generateRoutesModule(options: GenerateRoutesModuleOptions): CommandResult {
  const { ctx, configDir, results, check, routesConfig } = options
  const routesDirRel = options.routesDirFlag ?? routesConfig.dir ?? DEFAULT_ROUTES_DIR
  const routesDir = isAbsolute(routesDirRel) ? routesDirRel : join(configDir, routesDirRel)
  const outRel =
    options.outFlag ?? routesConfig.out ?? DEFAULT_GENERATED_ROUTES_MODULE_RELATIVE_PATH
  const outPath = isAbsolute(outRel)
    ? outRel
    : options.outFlag
      ? resolve(ctx.cwd, outRel)
      : join(configDir, outRel)
  const printableOut = relative(ctx.cwd, outPath) || outPath

  let ejected = 0
  let metadataOnly = 0
  const supersededFiles: string[] = []
  const sections: AdminRoutesModuleSection[] = []
  const found = foundEntries(results)

  for (const entry of found) {
    let source: string
    try {
      source = readFileSync(entry.sourcePath, "utf8")
    } catch {
      ctx.stderr(`[admin-generate] routes: note — ${entry.importSpec} source not readable\n`)
      continue
    }

    const routes: AdminRoutesModuleRoute[] = []
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
      if (!isImplementedContribution(contribution)) {
        metadataOnly++
        continue
      }

      // Route-level ejection: a route file for this path that is NOT
      // generator-owned means the host hand-binds it — leave it out.
      const existingFiles = [
        canonicalRouteFileRelPath(contribution.path),
        ...alternativeRouteFileRelPaths(contribution.path),
      ]
        .map((rel) => join(routesDir, rel))
        .filter((candidate) => existsSync(candidate))
      const handWritten = existingFiles.find(
        (file) => !isGeneratedRouteFile(readFileSync(file, "utf8")),
      )
      if (handWritten !== undefined) {
        ejected++
        const printableFile = relative(ctx.cwd, handWritten) || handWritten
        ctx.stderr(
          `[admin-generate] routes: skipped ${contribution.path} — hand-written host ` +
            `${printableFile} binds this route (ejected)\n`,
        )
        continue
      }
      // Leftover generated thin files (increment 1) are superseded by the module.
      supersededFiles.push(...existingFiles)

      let searchSchemaIdent: string | null = null
      if (contribution.hasValidateSearch) {
        searchSchemaIdent =
          contribution.validateSearchRaw === null
            ? null
            : resolveSearchSchemaIdent(contribution.validateSearchRaw, source)
        if (searchSchemaIdent === null) {
          ctx.stderr(
            `[admin-generate] routes: note — ${contribution.id} has a validateSearch whose ` +
              `schema is not an export of ${entry.importSpec}; emitted without a typed ` +
              `search contract\n`,
          )
        }
      }

      routes.push({
        constName: `${toPascalCase(contribution.id)}Route`,
        routeId: contribution.id,
        path: contribution.path,
        searchSchemaIdent,
      })
    }

    if (routes.length > 0) {
      sections.push({
        extensionId: scanExtensionId(source) ?? entry.domain,
        importSpec: entry.importSpec,
        routes,
      })
    }
  }

  sections.sort((a, b) =>
    a.extensionId < b.extensionId ? -1 : a.extensionId > b.extensionId ? 1 : 0,
  )
  const routeCount = sections.reduce((sum, section) => sum + section.routes.length, 0)

  if (routeCount === 0) {
    const stale = existsSync(outPath) ? readFileSync(outPath, "utf8") : null
    if (stale !== null && isGeneratedRouteFile(stale)) {
      if (check) {
        ctx.stderr(
          `[admin-generate] routes: ${printableOut} is stale — no implemented extension ` +
            `route contributions remain; run \`voyant admin generate --routes\`\n`,
        )
        return 1
      }
      rmSync(outPath)
      ctx.stdout(
        `[admin-generate] routes: removed ${printableOut} — no implemented extension ` +
          `route contributions remain\n`,
      )
      return 0
    }
    if (stale !== null) {
      ctx.stderr(
        `[admin-generate] routes: ${printableOut} has no generated header (ejected, ` +
          `host-owned) — left in place despite zero implemented contributions\n`,
      )
    }
    ctx.stdout(
      `[admin-generate] routes: no implemented extension route contributions across ` +
        `${found.length} admin entries — nothing to emit\n`,
    )
    return 0
  }

  // Alias derivation needs a config-relative dir: an absolute --routes-dir
  // would otherwise produce imports like `@//abs/path/...`.
  const routesDirForAlias = isAbsolute(routesDirRel)
    ? relative(configDir, routesDirRel).replaceAll("\\", "/")
    : routesDirRel
  if (
    !routesConfig.workspaceRouteModule &&
    (routesDirForAlias.startsWith("..") || isAbsolute(routesDirForAlias))
  ) {
    ctx.stderr(
      `[admin-generate] routes: --routes-dir resolves outside the project root — set ` +
        `admin.routes.workspaceRouteModule in voyant.config.* to the host's workspace ` +
        `layout import\n`,
    )
    return 1
  }
  const content = renderAdminRoutesModule({
    moduleBaseName: basename(outPath).replace(/\.[^.]+$/, ""),
    sections,
    imports: routesConfig.imports,
    workspaceRouteModule:
      routesConfig.workspaceRouteModule ?? workspaceRouteModuleFor(routesDirForAlias),
    routeIdPrefix: routeIdPrefixFor(routesDirForAlias),
  })

  const existing = existsSync(outPath) ? readFileSync(outPath, "utf8") : null
  if (existing !== null && !isGeneratedRouteFile(existing)) {
    ctx.stderr(
      `[admin-generate] routes: skipped ${printableOut} — it has no generated header ` +
        `(ejected, host-owned)\n`,
    )
    return 0
  }

  const summary = (state: string): string =>
    `[admin-generate] routes: ${routeCount} extension route(s) across ${sections.length} ` +
    `extension(s) — ${printableOut} ${state}, ${ejected} ejected, ${metadataOnly} ` +
    `metadata-only contribution(s) left to hand-written hosts\n`

  if (check) {
    let drift = 0
    if (existing !== content) {
      drift++
      ctx.stderr(
        existing === null
          ? `[admin-generate] routes: ${printableOut} is missing — run \`voyant admin generate --routes\`\n`
          : `[admin-generate] routes: ${printableOut} is out of date — run \`voyant admin generate --routes\`\n`,
      )
    }
    for (const file of supersededFiles) {
      drift++
      const printableFile = relative(ctx.cwd, file) || file
      ctx.stderr(
        `[admin-generate] routes: ${printableFile} is a generated thin route file superseded ` +
          `by ${printableOut} — run \`voyant admin generate --routes\`\n`,
      )
    }
    ctx.stdout(summary(drift > 0 ? "drifted" : "is up to date"))
    return drift > 0 ? 1 : 0
  }

  for (const file of supersededFiles) {
    rmSync(file)
    const printableFile = relative(ctx.cwd, file) || file
    ctx.stdout(
      `[admin-generate] routes: removed ${printableFile} (superseded generated thin route file)\n`,
    )
  }
  if (existing === content) {
    ctx.stdout(summary("is up to date"))
    return 0
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, content)
  ctx.stdout(summary(existing === null ? "written" : "rewritten"))
  return 0
}

interface GenerateDestinationsModuleOptions {
  ctx: CommandContext
  configDir: string
  results: ReadonlyArray<AdminEntryScanResult>
  check: boolean
  outFlag: string | undefined
}

/**
 * `voyant admin generate --destinations` — emit the generated destination
 * resolver map (packaged-admin RFC §4.7 endgame).
 *
 * Per annotated contribution:
 * - no statically resolvable route path → note, skipped (the generator only
 *   trusts what it can read without executing the entry)
 * - duplicate destination key across contributions → first wins, noted
 * - otherwise → a pure path-interpolation resolver is emitted
 *
 * A target module without the generated header is the host's own (ejected
 * wholesale) and is never overwritten. When no annotations remain, a stale
 * generated module is removed (reported as drift with `--check`).
 */
function generateDestinationsModule(options: GenerateDestinationsModuleOptions): CommandResult {
  const { ctx, configDir, results, check } = options
  const outRel = options.outFlag ?? DEFAULT_GENERATED_DESTINATIONS_MODULE_RELATIVE_PATH
  const outPath = isAbsolute(outRel)
    ? outRel
    : options.outFlag
      ? resolve(ctx.cwd, outRel)
      : join(configDir, outRel)
  const printableOut = relative(ctx.cwd, outPath) || outPath

  const found = foundEntries(results)
  const sources: Array<{ importSpec: string; source: string }> = []
  for (const entry of found) {
    try {
      sources.push({ importSpec: entry.importSpec, source: readFileSync(entry.sourcePath, "utf8") })
    } catch {
      ctx.stderr(`[admin-generate] destinations: note — ${entry.importSpec} source not readable\n`)
    }
  }

  const { bindings, notes } = collectDestinationBindings(sources)
  for (const note of notes) {
    ctx.stderr(`[admin-generate] destinations: note — ${note}\n`)
  }

  if (bindings.length === 0) {
    const stale = existsSync(outPath) ? readFileSync(outPath, "utf8") : null
    if (stale !== null && isGeneratedDestinationsFile(stale)) {
      if (check) {
        ctx.stderr(
          `[admin-generate] destinations: ${printableOut} is stale — no route-backed ` +
            `destination annotations remain; run \`voyant admin generate --destinations\`\n`,
        )
        return 1
      }
      rmSync(outPath)
      ctx.stdout(
        `[admin-generate] destinations: removed ${printableOut} — no route-backed ` +
          `destination annotations remain\n`,
      )
      return 0
    }
    if (stale !== null) {
      ctx.stderr(
        `[admin-generate] destinations: ${printableOut} has no generated header (ejected, ` +
          `host-owned) — left in place despite zero destination annotations\n`,
      )
    }
    ctx.stdout(
      `[admin-generate] destinations: no route-backed destination annotations across ` +
        `${found.length} admin entries — nothing to emit\n`,
    )
    return 0
  }

  const content = renderAdminDestinationsModule({
    bindings,
    importSpecs: sources.map((entry) => entry.importSpec),
  })

  const existing = existsSync(outPath) ? readFileSync(outPath, "utf8") : null
  if (existing !== null && !isGeneratedDestinationsFile(existing)) {
    ctx.stderr(
      `[admin-generate] destinations: skipped ${printableOut} — it has no generated header ` +
        `(ejected, host-owned)\n`,
    )
    return 0
  }

  const summary = (state: string): string =>
    `[admin-generate] destinations: ${bindings.length} route-backed resolver(s) across ` +
    `${found.length} admin entries — ${printableOut} ${state}\n`

  if (check) {
    if (existing !== content) {
      ctx.stderr(
        existing === null
          ? `[admin-generate] destinations: ${printableOut} is missing — run \`voyant admin generate --destinations\`\n`
          : `[admin-generate] destinations: ${printableOut} is out of date — run \`voyant admin generate --destinations\`\n`,
      )
      ctx.stdout(summary("drifted"))
      return 1
    }
    ctx.stdout(summary("is up to date"))
    return 0
  }

  if (existing === content) {
    ctx.stdout(summary("is up to date"))
    return 0
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, content)
  ctx.stdout(summary(existing === null ? "written" : "rewritten"))
  return 0
}

/**
 * `voyant admin generate --routes --files` — LEGACY per-route thin files
 * (RFC §4.2 increment 1) for hosts not yet on the code-assembled module:
 * one generated host file per zero-prop route contribution.
 *
 * Per contribution:
 * - no statically resolvable id/path → note, skipped (the generator only
 *   trusts what it can read without executing the entry)
 * - path contains `$param` segments → skipped, hand-written hosts bind params
 * - no `component` → skipped (thin files cannot bind lazy `page` modules —
 *   migrate to the code-assembled module for those)
 * - an existing file WITHOUT the generated header → skipped and reported:
 *   that file is ejected (hand-written), and stays the host's own
 * - otherwise → written (or, with `--check`, compared for drift)
 */
function generateRouteFiles(options: GenerateRouteFilesOptions): CommandResult {
  const { ctx, configDir, results, check, routesConfig } = options
  const routesDirRel = options.routesDirFlag ?? routesConfig.dir ?? DEFAULT_ROUTES_DIR
  const routesDir = isAbsolute(routesDirRel) ? routesDirRel : join(configDir, routesDirRel)

  let eligible = 0
  let written = 0
  let upToDate = 0
  let ejected = 0
  let paramSkipped = 0
  let metadataOnly = 0
  let drift = 0

  const found = foundEntries(results)

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
        runtime: routesConfig.imports,
      })

      if (existing === content) {
        upToDate++
        continue
      }
      if (check) {
        drift++
        ctx.stderr(
          existing === null
            ? `[admin-generate] routes: ${printable} is missing — run \`voyant admin generate --routes --files\`\n`
            : `[admin-generate] routes: ${printable} is out of date — run \`voyant admin generate --routes --files\`\n`,
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
