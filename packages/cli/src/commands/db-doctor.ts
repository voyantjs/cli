import { existsSync, readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path"
import { pathToFileURL } from "node:url"

import type { LinkDefinition } from "@voyantjs/core/links"

import { parseArgs } from "../lib/args.js"
import {
  defaultLinkSchemaEntry,
  materializedLinks,
  readLinkSchemaManifest,
  renderLinkSchemaManifest,
} from "../lib/link-schema-manifest.js"
import { loadVoyantConfig } from "../lib/load-voyant-config.js"
import {
  readSchemaManifest,
  renderSchemaManifest,
  resolveSchemaManifest,
} from "../lib/schema-manifest.js"
import type { CommandContext, CommandResult } from "../types.js"
import { loadLinks, resolveLinksPath } from "./db-sync-links.js"

const DRIZZLE_CONFIG_NAMES = ["drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs"]
const DUPLICATE_PREFIX_BASELINE_NAME = "duplicate-prefixes.baseline.json"

interface DrizzleConfigLike {
  schema?: string | string[]
  out?: string
}

interface DoctorIssue {
  level: "warn"
  message: string
  details?: string[]
}

interface DuplicateMigrationPrefix {
  prefix: string
  files: string[]
}

interface DuplicatePrefixBaseline {
  duplicates?: DuplicateMigrationPrefix[]
}

interface SchemaComparison {
  expected: string[]
  actual: string[]
  localSchemas: string[]
  missing: string[]
  extra: string[]
}

export async function dbDoctorCommand(ctx: CommandContext): Promise<CommandResult> {
  const { flags } = parseArgs(ctx.argv)
  const templateDir = resolveTemplateDir(ctx.cwd, flags.template)
  if (!templateDir) {
    ctx.stderr(
      "Could not find a template with drizzle.config.{ts,js,mjs}. " +
        "Run this command from a template directory, or pass --template <path>.\n",
    )
    return 1
  }

  const drizzleConfigPath = findDrizzleConfigPath(templateDir)
  if (!drizzleConfigPath) {
    ctx.stderr(`Could not find drizzle.config.{ts,js,mjs} in ${templateDir}\n`)
    return 1
  }

  const configPath = typeof flags.config === "string" ? flags.config : null
  const voyantConfig = await loadVoyantConfig(templateDir, configPath)
  if (!voyantConfig) {
    ctx.stderr(
      "Could not locate a voyant.config.ts. Run from a directory containing one, " +
        "pass --template <path>, or pass --config <path>.\n",
    )
    return 1
  }

  let drizzleConfig: DrizzleConfigLike
  try {
    drizzleConfig = await loadDrizzleConfig(drizzleConfigPath)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.stderr(`Failed to load ${drizzleConfigPath}: ${reason}\n`)
    return 1
  }

  const issues: DoctorIssue[] = []
  const notes: string[] = []
  const linkResolution = await resolveTemplateLinks(templateDir, issues)
  const additionalSchemas =
    linkResolution.links && materializedLinks(linkResolution.links).length > 0
      ? [defaultLinkSchemaEntry()]
      : []

  let schemaComparison: SchemaComparison
  try {
    schemaComparison = compareSchemas(voyantConfig, drizzleConfig, templateDir, additionalSchemas)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.stderr(`Failed to compare schema manifests: ${reason}\n`)
    return 1
  }

  if (schemaComparison.missing.length > 0) {
    issues.push({
      level: "warn",
      message: "Manifest-derived schemas are missing from drizzle.config.",
      details: schemaComparison.missing.map((p) => formatPath(templateDir, p)),
    })
  }
  if (schemaComparison.extra.length > 0) {
    issues.push({
      level: "warn",
      message: "drizzle.config has schema entries not derived from voyant.config.",
      details: schemaComparison.extra.map((p) => formatPath(templateDir, p)),
    })
  }
  if (schemaComparison.missing.length === 0 && schemaComparison.extra.length === 0) {
    notes.push(
      `Schemas: ${schemaComparison.expected.length} manifest-derived schema(s) match drizzle.config.`,
    )
  }
  if (schemaComparison.localSchemas.length > 0) {
    notes.push(
      `Template-local schemas: ${schemaComparison.localSchemas
        .map((p) => formatPath(templateDir, p))
        .join(", ")}`,
    )
  }

  checkGeneratedLinkSchemaManifest(linkResolution, templateDir, issues, notes)
  checkGeneratedSchemaManifest(voyantConfig, templateDir, additionalSchemas, issues, notes)

  const outDir = resolvePath(templateDir, drizzleConfig.out ?? "./drizzle")
  const duplicatePrefixes = findDuplicateMigrationPrefixes(outDir)
  const duplicateBaseline = loadDuplicatePrefixBaseline(outDir)
  const baselinedDuplicates = duplicatePrefixes.filter((duplicate) =>
    isDuplicatePrefixBaselined(duplicate, duplicateBaseline.entries),
  )
  const unbaselinedDuplicates = duplicatePrefixes.filter(
    (duplicate) => !isDuplicatePrefixBaselined(duplicate, duplicateBaseline.entries),
  )

  for (const duplicate of unbaselinedDuplicates) {
    issues.push({
      level: "warn",
      message: `Duplicate migration prefix "${duplicate.prefix}" in ${formatPath(
        templateDir,
        outDir,
      )}.`,
      details: duplicate.files,
    })
  }

  const staleBaselineEntries = duplicateBaseline.entries.filter(
    (entry) => !isDuplicatePrefixBaselined(entry, duplicatePrefixes),
  )
  if (staleBaselineEntries.length > 0) {
    issues.push({
      level: "warn",
      message: `Duplicate migration prefix baseline has stale entries: ${formatPath(
        templateDir,
        duplicateBaseline.path,
      )}.`,
      details: staleBaselineEntries.map((entry) => `${entry.prefix}: ${entry.files.join(", ")}`),
    })
  }

  if (duplicatePrefixes.length === 0) {
    notes.push("Migration prefixes: no duplicates found.")
  } else if (unbaselinedDuplicates.length === 0 && staleBaselineEntries.length === 0) {
    notes.push(
      `Migration prefixes: no unbaselined duplicates found (${baselinedDuplicates.length} legacy duplicate prefix group(s) baselined).`,
    )
  } else if (baselinedDuplicates.length > 0) {
    notes.push(
      `Migration prefixes: ${baselinedDuplicates.length} legacy duplicate prefix group(s) baselined.`,
    )
  }

  checkLinkSnapshots(templateDir, outDir, linkResolution, issues, notes)

  const failOnDrift = flags["fail-on-drift"] === true
  printReport(ctx, {
    templateDir,
    drizzleConfigPath,
    issues,
    notes,
    failOnDrift,
  })

  return failOnDrift && issues.length > 0 ? 1 : 0
}

function resolveTemplateDir(cwd: string, override: string | boolean | undefined): string | null {
  const roots =
    typeof override === "string"
      ? [isAbsolute(override) ? override : resolvePath(cwd, override)]
      : [cwd]

  for (const root of roots) {
    if (findDrizzleConfigPath(root)) return root
  }
  return null
}

function findDrizzleConfigPath(templateDir: string): string | null {
  for (const name of DRIZZLE_CONFIG_NAMES) {
    const candidate = join(templateDir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function loadDrizzleConfig(configPath: string): Promise<DrizzleConfigLike> {
  const previousQuiet = process.env.DOTENV_CONFIG_QUIET
  if (previousQuiet === undefined) {
    process.env.DOTENV_CONFIG_QUIET = "true"
  }
  try {
    const mod = await import(pathToFileURL(configPath).href)
    return (mod.default ?? mod) as DrizzleConfigLike
  } finally {
    if (previousQuiet === undefined) {
      delete process.env.DOTENV_CONFIG_QUIET
    } else {
      process.env.DOTENV_CONFIG_QUIET = previousQuiet
    }
  }
}

function compareSchemas(
  voyantConfig: Parameters<typeof resolveSchemaManifest>[0],
  drizzleConfig: DrizzleConfigLike,
  templateDir: string,
  additionalSchemas: string[],
): SchemaComparison {
  const expected = resolveSchemaManifest(voyantConfig, {
    cwd: templateDir,
    style: "file",
    additionalSchemas,
  }).map(normalizePath)
  const actual = extractDrizzleSchemaEntries(drizzleConfig).map((entry) =>
    normalizePath(resolveSchemaEntry(entry, templateDir)),
  )

  const manifestOnly = resolveSchemaManifest(voyantConfig, {
    cwd: templateDir,
    style: "file",
  }).map(normalizePath)
  const localSchemas = manifestOnly.filter((entry) => !isVoyantPackageSchemaPath(entry))

  return {
    expected,
    actual,
    localSchemas,
    missing: expected.filter((entry) => !actual.includes(entry)),
    extra: actual.filter((entry) => !expected.includes(entry)),
  }
}

function checkGeneratedSchemaManifest(
  voyantConfig: Parameters<typeof resolveSchemaManifest>[0],
  templateDir: string,
  additionalSchemas: string[],
  issues: DoctorIssue[],
  notes: string[],
): void {
  const generated = renderSchemaManifest(voyantConfig, { cwd: templateDir, additionalSchemas })
  const current = readSchemaManifest(generated.path)
  const manifestPath = formatPath(templateDir, generated.path)

  if (current === null) {
    issues.push({
      level: "warn",
      message: `Generated schema manifest is missing: ${manifestPath}.`,
      details: ["Run `voyant db schemas --emit` or `voyant db generate` to refresh."],
    })
    return
  }

  if (current !== generated.content) {
    issues.push({
      level: "warn",
      message: `Generated schema manifest is stale: ${manifestPath}.`,
      details: ["Run `voyant db schemas --emit` or `voyant db generate` to refresh."],
    })
    return
  }

  notes.push(`Generated schema manifest: ${manifestPath} is up to date.`)
}

interface LinkResolution {
  path: string | null
  links: LinkDefinition[] | null
}

async function resolveTemplateLinks(
  templateDir: string,
  issues: DoctorIssue[],
): Promise<LinkResolution> {
  const linksPath = resolveLinksPath(templateDir, {})
  if (!linksPath) return { path: null, links: null }

  try {
    return { path: linksPath, links: await loadLinks(linksPath) }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    issues.push({
      level: "warn",
      message: `Could not load link definitions from ${formatPath(templateDir, linksPath)}.`,
      details: [reason],
    })
    return { path: linksPath, links: null }
  }
}

function checkGeneratedLinkSchemaManifest(
  linkResolution: LinkResolution,
  templateDir: string,
  issues: DoctorIssue[],
  notes: string[],
): void {
  if (!linkResolution.path || !linkResolution.links) return
  if (materializedLinks(linkResolution.links).length === 0) return

  const generated = renderLinkSchemaManifest(linkResolution.links, {
    cwd: templateDir,
    sourcePath: linkResolution.path,
  })
  const current = readLinkSchemaManifest(generated.path)
  const manifestPath = formatPath(templateDir, generated.path)

  if (current === null) {
    issues.push({
      level: "warn",
      message: `Generated link schema is missing: ${manifestPath}.`,
      details: ["Run `voyant db schemas --emit` or `voyant db generate` to refresh."],
    })
    return
  }

  if (current !== generated.content) {
    issues.push({
      level: "warn",
      message: `Generated link schema is stale: ${manifestPath}.`,
      details: ["Run `voyant db schemas --emit` or `voyant db generate` to refresh."],
    })
    return
  }

  notes.push(`Generated link schema: ${manifestPath} is up to date.`)
}

function extractDrizzleSchemaEntries(config: DrizzleConfigLike): string[] {
  if (typeof config.schema === "string") return [config.schema]
  if (Array.isArray(config.schema)) {
    return config.schema.filter((entry): entry is string => typeof entry === "string")
  }
  throw new Error("drizzle.config must expose a string or string[] `schema` field")
}

function resolveSchemaEntry(entry: string, templateDir: string): string {
  if (entry.startsWith(".") || isAbsolute(entry)) {
    return isAbsolute(entry) ? entry : resolvePath(templateDir, entry)
  }

  const require = createRequire(join(templateDir, "package.json"))
  return require.resolve(entry)
}

function isVoyantPackageSchemaPath(path: string): boolean {
  const normalized = normalizePath(path)
  return normalized.includes("/packages/") || normalized.includes("/node_modules/@voyantjs/")
}

function findDuplicateMigrationPrefixes(outDir: string): DuplicateMigrationPrefix[] {
  if (!existsSync(outDir)) return []

  const byPrefix = new Map<string, string[]>()
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue
    const match = /^(\d+)_/.exec(entry.name)
    if (!match) continue
    const prefix = match[1] as string
    const files = byPrefix.get(prefix) ?? []
    files.push(entry.name)
    byPrefix.set(prefix, files)
  }

  return [...byPrefix.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([prefix, files]) => ({ prefix, files: [...files].sort() }))
}

function loadDuplicatePrefixBaseline(outDir: string): {
  path: string
  entries: DuplicateMigrationPrefix[]
} {
  const path = join(outDir, DUPLICATE_PREFIX_BASELINE_NAME)
  if (!existsSync(path)) return { path, entries: [] }

  const raw = readFileSync(path, "utf8")
  const parsed = JSON.parse(raw) as DuplicatePrefixBaseline
  return {
    path,
    entries: normalizeDuplicatePrefixEntries(parsed.duplicates ?? []),
  }
}

function normalizeDuplicatePrefixEntries(
  entries: ReadonlyArray<DuplicateMigrationPrefix>,
): DuplicateMigrationPrefix[] {
  return entries
    .filter((entry) => typeof entry.prefix === "string" && Array.isArray(entry.files))
    .map((entry) => ({
      prefix: entry.prefix,
      files: entry.files.filter((file): file is string => typeof file === "string").sort(),
    }))
}

function isDuplicatePrefixBaselined(
  duplicate: DuplicateMigrationPrefix,
  baseline: ReadonlyArray<DuplicateMigrationPrefix>,
): boolean {
  const duplicateFiles = [...duplicate.files].sort()
  return baseline.some(
    (entry) =>
      entry.prefix === duplicate.prefix &&
      entry.files.length === duplicateFiles.length &&
      entry.files.every((file, index) => file === duplicateFiles[index]),
  )
}

function checkLinkSnapshots(
  templateDir: string,
  outDir: string,
  linkResolution: LinkResolution,
  issues: DoctorIssue[],
  notes: string[],
): void {
  if (!linkResolution.path) {
    notes.push("Links: no link definitions found.")
    return
  }

  if (!linkResolution.links) {
    return
  }

  const materialized = materializedLinks(linkResolution.links)
  if (materialized.length === 0) {
    notes.push("Links: only read-only links found.")
    return
  }

  const snapshotTables = loadLatestSnapshotTables(outDir)
  if (!snapshotTables) {
    issues.push({
      level: "warn",
      message: `No Drizzle snapshot found under ${formatPath(templateDir, join(outDir, "meta"))}.`,
    })
    return
  }

  const missing = materialized
    .map((link) => link.tableName)
    .filter((tableName) => !snapshotTables.has(tableName))

  if (missing.length > 0) {
    issues.push({
      level: "warn",
      message: "Link tables are missing from the latest Drizzle snapshot.",
      details: [...missing].sort(),
    })
    return
  }

  notes.push(`Links: ${materialized.length} materialized link table(s) found in snapshot.`)
}

function loadLatestSnapshotTables(outDir: string): Set<string> | null {
  const metaDir = join(outDir, "meta")
  if (!existsSync(metaDir)) return null

  const snapshots = readdirSync(metaDir)
    .filter((name) => /^\d+_snapshot\.json$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  const latest = snapshots.at(-1)
  if (!latest) return null

  const raw = readFileSync(join(metaDir, latest), "utf8")
  const parsed = JSON.parse(raw) as { tables?: Record<string, unknown> }
  const tableKeys = Object.keys(parsed.tables ?? {})
  return new Set(tableKeys.map((key) => key.slice(key.lastIndexOf(".") + 1)))
}

function printReport(
  ctx: CommandContext,
  args: {
    templateDir: string
    drizzleConfigPath: string
    issues: DoctorIssue[]
    notes: string[]
    failOnDrift: boolean
  },
): void {
  ctx.stdout("voyant db doctor (report)\n")
  ctx.stdout(`Template: ${args.templateDir}\n`)
  ctx.stdout(`Drizzle config: ${formatPath(args.templateDir, args.drizzleConfigPath)}\n\n`)

  for (const note of args.notes) {
    ctx.stdout(`OK ${note}\n`)
  }

  for (const issue of args.issues) {
    ctx.stdout(`${issue.level.toUpperCase()} ${issue.message}\n`)
    for (const detail of issue.details ?? []) {
      ctx.stdout(`  - ${detail}\n`)
    }
  }

  if (args.issues.length === 0) {
    ctx.stdout("\nNo drift detected.\n")
    return
  }

  ctx.stdout(
    `\n${args.issues.length} issue(s) reported. ` +
      (args.failOnDrift
        ? "Exiting non-zero because --fail-on-drift was set.\n"
        : "Report mode exits 0; pass --fail-on-drift to gate CI.\n"),
  )
}

function normalizePath(path: string): string {
  return resolvePath(path).replaceAll("\\", "/")
}

function formatPath(baseDir: string, path: string): string {
  const rel = relative(baseDir, path).replaceAll("\\", "/")
  if (!rel.startsWith("..") && rel !== "") return rel
  return path
}
