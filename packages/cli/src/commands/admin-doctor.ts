import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

import type { VoyantConfig } from "@voyantjs/core/config"

import {
  type AdminEntryScanResult,
  DEFAULT_GENERATED_RELATIVE_PATH,
  scanAdminEntries,
} from "../lib/admin-entries.js"
import { scanDeclaredDestinationKeys, scanResolverMapKeys } from "../lib/admin-routes.js"
import { getStringFlag, parseArgs } from "../lib/args.js"
import { loadVoyantConfigFile, resolveConfigPath } from "../lib/config-loader.js"
import type { CommandContext, CommandResult } from "../types.js"

/** Default location (relative to the config dir) of the host's destination resolver map. */
export const DEFAULT_DESTINATIONS_RELATIVE_PATH = "src/lib/admin-destinations.ts"

/**
 * `voyant admin doctor [--config <path>] [--out <file>] [--destinations <file>]`
 *
 * Report-only parity check for the manifest ↔ admin extension ↔ route chain
 * (packaged-admin RFC §4.1). Always exits 0 in this pass; CI can grep the
 * `[admin-doctor]` lines until the check graduates to a gate.
 *
 * - **A** — a module's admin entry exists but is not imported in the
 *   generated composition file (or the file is missing entirely).
 * - **B** — the generated file imports an admin entry whose module is no
 *   longer in the manifest.
 * - **C** — best-effort route parity: `path: "..."` literals declared in an
 *   admin entry's source have no plausible route file under
 *   `src/routes/_workspace/**`. Static scan only — nothing is imported.
 * - **D** — destination parity (RFC §4.7): `AdminDestinations` keys the
 *   mounted admin entries declare via `declare module "@voyantjs/admin"`
 *   versus the keys of the host's resolver map (the object literal marked
 *   `satisfies AdminDestinationResolvers`, default
 *   `src/lib/admin-destinations.ts`, override with `--destinations`).
 *   Reported in both directions: declared-but-unresolved and
 *   resolver-without-declaration.
 */
export async function adminDoctorCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const configFlag = getStringFlag(args, "config")
  const outFlag = getStringFlag(args, "out")

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
  const results = scanAdminEntries(config.modules ?? [], configDir)
  const found = results.filter((result) => result.status === "found")

  const generatedPath = outFlag
    ? isAbsolute(outFlag)
      ? outFlag
      : resolve(ctx.cwd, outFlag)
    : join(configDir, DEFAULT_GENERATED_RELATIVE_PATH)
  const printableGenerated = relative(ctx.cwd, generatedPath) || generatedPath

  let findings = 0
  const report = (line: string): void => {
    findings++
    ctx.stdout(`[admin-doctor] ${line}\n`)
  }

  // Finding A: admin entry exists but is not imported in the generated file.
  const generatedSource = existsSync(generatedPath) ? readFileSync(generatedPath, "utf8") : null
  const importedSpecs = generatedSource === null ? [] : parseImportSpecs(generatedSource)
  if (generatedSource === null && found.length > 0) {
    report(`A: generated file ${printableGenerated} is missing — run \`voyant admin generate\``)
  }
  for (const entry of found) {
    if (generatedSource === null) {
      report(`A: admin entry ${entry.importSpec} (module ${entry.moduleName}) is not composed`)
      continue
    }
    if (entry.importSpec && !importedSpecs.includes(entry.importSpec)) {
      report(
        `A: admin entry ${entry.importSpec} (module ${entry.moduleName}) is not imported in ${printableGenerated}`,
      )
    }
  }

  // Finding B: generated imports whose module left the manifest. Compare
  // against candidate specs for ALL manifest modules (found or not), so a
  // module that merely lost its ui package doesn't masquerade as removed.
  const manifestSpecs = new Set(
    results.map((result) => result.importSpec).filter((spec): spec is string => Boolean(spec)),
  )
  for (const spec of importedSpecs) {
    if (!manifestSpecs.has(spec)) {
      report(
        `B: ${spec} is imported in ${printableGenerated} but its module is not in the manifest`,
      )
    }
  }

  // Finding C: best-effort route parity against file-based routing.
  const workspaceRoutesDir = join(configDir, "src", "routes", "_workspace")
  if (!existsSync(join(configDir, "src", "routes"))) {
    ctx.stdout(`[admin-doctor] C: skipped route parity — no src/routes directory in host\n`)
  } else {
    for (const entry of found) {
      for (const routePath of declaredRoutePaths(entry)) {
        if (!routeFileExists(workspaceRoutesDir, routePath)) {
          report(`C: no route file found for ${routePath} (extension ${entry.importSpec})`)
        }
      }
    }
  }

  // Finding D: destination parity — AdminDestinations declarations in the
  // mounted admin entries vs the host's resolver map (RFC §4.7).
  const destinationsFlag = getStringFlag(args, "destinations")
  const destinationsPath = destinationsFlag
    ? isAbsolute(destinationsFlag)
      ? destinationsFlag
      : resolve(ctx.cwd, destinationsFlag)
    : join(configDir, DEFAULT_DESTINATIONS_RELATIVE_PATH)
  const printableDestinations = relative(ctx.cwd, destinationsPath) || destinationsPath

  if (!existsSync(destinationsPath)) {
    ctx.stdout(
      `[admin-doctor] D: skipped destination parity — no ${printableDestinations} in host\n`,
    )
  } else {
    const resolverKeys = scanResolverMapKeys(readFileSync(destinationsPath, "utf8"))
    if (resolverKeys === null) {
      ctx.stdout(
        `[admin-doctor] D: skipped destination parity — no \`satisfies AdminDestinationResolvers\` map in ${printableDestinations}\n`,
      )
    } else {
      const resolverKeySet = new Set(resolverKeys)
      const declaredBy = new Map<string, string[]>()
      for (const entry of found) {
        if (!entry.sourcePath || !entry.importSpec) continue
        let source: string
        try {
          source = readFileSync(entry.sourcePath, "utf8")
        } catch {
          continue
        }
        for (const key of scanDeclaredDestinationKeys(source)) {
          const declarers = declaredBy.get(key) ?? []
          declarers.push(entry.importSpec)
          declaredBy.set(key, declarers)
        }
      }
      for (const [key, declarers] of declaredBy) {
        if (!resolverKeySet.has(key)) {
          report(
            `D: destination "${key}" declared by ${declarers.join(", ")} has no resolver in ${printableDestinations}`,
          )
        }
      }
      for (const key of resolverKeys) {
        if (!declaredBy.has(key)) {
          report(
            `D: resolver for "${key}" in ${printableDestinations} matches no declared destination`,
          )
        }
      }
    }
  }

  ctx.stdout(
    `[admin-doctor] done: ${results.length} modules, ${found.length} admin entries, ${findings} finding(s)\n`,
  )
  return 0
}

/** Extract `from "<spec>"` specifiers from a generated composition file. */
export function parseImportSpecs(source: string): string[] {
  const specs: string[] = []
  const pattern = /\bfrom\s+["']([^"']+)["']/g
  let match: RegExpExecArray | null = pattern.exec(source)
  while (match !== null) {
    if (match[1] !== undefined) specs.push(match[1])
    match = pattern.exec(source)
  }
  return specs
}

/**
 * Statically scan an admin entry's source for declared route paths. Matches
 * `path: "/x"` object literals and `path = "/x"` destructuring defaults;
 * only absolute admin paths count.
 */
function declaredRoutePaths(entry: AdminEntryScanResult): string[] {
  if (!entry.sourcePath) return []
  let source: string
  try {
    source = readFileSync(entry.sourcePath, "utf8")
  } catch {
    return []
  }
  const paths = new Set<string>()
  const pattern = /\bpath\s*[:=]\s*["']([^"']+)["']/g
  let match: RegExpExecArray | null = pattern.exec(source)
  while (match !== null) {
    const value = match[1]
    if (value?.startsWith("/") && value !== "/") paths.add(value)
    match = pattern.exec(source)
  }
  return [...paths]
}

/**
 * Does a plausible route file exist for `routePath` (e.g. `/promotions`)
 * under the host's `src/routes/_workspace/`? Probes nested
 * (`promotions/index.tsx`, `promotions.tsx`) and flat dotted
 * (`promotions.index.tsx`) file-routing conventions.
 */
function routeFileExists(workspaceRoutesDir: string, routePath: string): boolean {
  const rel = routePath.replace(/^\//, "")
  const dotted = rel.replaceAll("/", ".")
  const candidates = [
    `${rel}.tsx`,
    `${rel}.ts`,
    join(rel, "index.tsx"),
    join(rel, "index.ts"),
    join(rel, "route.tsx"),
    `${dotted}.tsx`,
    `${dotted}.index.tsx`,
  ]
  return candidates.some((candidate) => existsSync(join(workspaceRoutesDir, candidate)))
}
