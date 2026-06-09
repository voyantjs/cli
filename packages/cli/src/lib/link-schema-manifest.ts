import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, relative, resolve as resolvePath } from "node:path"

import type { LinkDefinition } from "@voyantjs/core/links"

const DEFAULT_GENERATED_LINK_SCHEMA_FILE = "drizzle.links.generated.ts"

export interface RenderLinkSchemaOptions {
  cwd: string
  sourcePath?: string
  outPath?: string
}

export interface GeneratedLinkSchemaManifest {
  path: string
  content: string
  links: LinkDefinition[]
}

export function defaultLinkSchemaPath(cwd: string): string {
  return resolvePath(cwd, DEFAULT_GENERATED_LINK_SCHEMA_FILE)
}

export function defaultLinkSchemaEntry(): string {
  return `./${DEFAULT_GENERATED_LINK_SCHEMA_FILE}`
}

export function materializedLinks(links: LinkDefinition[]): LinkDefinition[] {
  return links.filter((link) => !link.readOnly)
}

export function renderLinkSchemaManifest(
  links: LinkDefinition[],
  options: RenderLinkSchemaOptions,
): GeneratedLinkSchemaManifest {
  const outPath = resolveOutputPath(options.cwd, options.outPath)
  const materialized = materializedLinks(links)
  const source =
    options.sourcePath === undefined
      ? "link definitions"
      : toPortableRelativePath(options.cwd, options.sourcePath)
  const content = renderContent(materialized, source)
  return { path: outPath, content, links: materialized }
}

export function writeLinkSchemaManifest(
  links: LinkDefinition[],
  options: RenderLinkSchemaOptions,
): GeneratedLinkSchemaManifest {
  const manifest = renderLinkSchemaManifest(links, options)
  writeFileSync(manifest.path, manifest.content)
  return manifest
}

export function readLinkSchemaManifest(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null
}

function renderContent(links: LinkDefinition[], source: string): string {
  const lines: string[] = [
    `// AUTO-GENERATED from ${source} - do not edit by hand.`,
    "// Run `voyant db schemas --emit` or `voyant db generate` to refresh.",
  ]

  if (links.length === 0) {
    lines.push("export {}")
    lines.push("")
    return lines.join("\n")
  }

  const usesRegularIndex = links.some((link) => link.left.isList || link.right.isList)
  const pgCoreImports = ["pgTable"]
  if (usesRegularIndex) pgCoreImports.push("index")
  pgCoreImports.push("text", "timestamp", "uniqueIndex")
  pgCoreImports.sort()

  lines.push('import { sql } from "drizzle-orm"')
  lines.push(`import { ${pgCoreImports.join(", ")} } from "drizzle-orm/pg-core"`)
  lines.push("")

  const tableNames = new Set<string>()
  for (const link of links) {
    const tableIdentifier = uniqueIdentifier(`${toIdentifier(link.tableName)}LinkTable`, tableNames)
    const columns = createColumnIdentifiers(link)
    lines.push(
      ...renderTable({
        link,
        tableIdentifier,
        leftIdentifier: columns.left,
        rightIdentifier: columns.right,
      }),
    )
    lines.push("")
  }

  return lines.join("\n")
}

function renderTable(args: {
  link: LinkDefinition
  tableIdentifier: string
  leftIdentifier: string
  rightIdentifier: string
}): string[] {
  const { link, tableIdentifier, leftIdentifier, rightIdentifier } = args
  const softDeleteWhereLine = `      .where(sql\`${"$"}{table.deletedAt} IS NULL\`),`
  const lines = [
    `export const ${tableIdentifier} = pgTable(`,
    `  ${JSON.stringify(link.tableName)},`,
    "  {",
    '    id: text("id").primaryKey(),',
    `    ${leftIdentifier}: text(${JSON.stringify(link.leftColumn)}).notNull(),`,
    `    ${rightIdentifier}: text(${JSON.stringify(link.rightColumn)}).notNull(),`,
    '    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),',
    '    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),',
    '    deletedAt: timestamp("deleted_at", { withTimezone: true }),',
    "  },",
    "  (table) => [",
    `    uniqueIndex(${JSON.stringify(`${link.tableName}_pair_idx`)})`,
    `      .on(table.${leftIdentifier}, table.${rightIdentifier})`,
    softDeleteWhereLine,
  ]

  if (link.right.isList) {
    lines.push(
      `    index(${JSON.stringify(`${link.tableName}_l_idx`)})`,
      `      .on(table.${leftIdentifier})`,
      softDeleteWhereLine,
    )
  } else {
    lines.push(
      `    uniqueIndex(${JSON.stringify(`${link.tableName}_l_uniq`)})`,
      `      .on(table.${leftIdentifier})`,
      softDeleteWhereLine,
    )
  }

  if (link.left.isList) {
    lines.push(
      `    index(${JSON.stringify(`${link.tableName}_r_idx`)})`,
      `      .on(table.${rightIdentifier})`,
      softDeleteWhereLine,
    )
  } else {
    lines.push(
      `    uniqueIndex(${JSON.stringify(`${link.tableName}_r_uniq`)})`,
      `      .on(table.${rightIdentifier})`,
      softDeleteWhereLine,
    )
  }

  lines.push("  ],", ")")
  return lines
}

function createColumnIdentifiers(link: LinkDefinition): { left: string; right: string } {
  const used = new Set(["id", "createdAt", "updatedAt", "deletedAt"])
  const left = uniqueIdentifier(toIdentifier(link.leftColumn), used)
  const right = uniqueIdentifier(toIdentifier(link.rightColumn), used)
  return { left, right }
}

function uniqueIdentifier(base: string, used: Set<string>): string {
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `${base}${suffix}`
    suffix += 1
  }
  used.add(candidate)
  return candidate
}

function toIdentifier(input: string): string {
  const parts = input
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .split("_")
    .filter(Boolean)

  const identifier = parts
    .map((part, index) => {
      if (index === 0) return `${part.slice(0, 1).toLowerCase()}${part.slice(1)}`
      return `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`
    })
    .join("")

  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(identifier)) return identifier
  return `link${identifier.slice(0, 1).toUpperCase()}${identifier.slice(1)}`
}

function resolveOutputPath(cwd: string, outPath: string | undefined): string {
  if (!outPath) return defaultLinkSchemaPath(cwd)
  return isAbsolute(outPath) ? outPath : resolvePath(cwd, outPath)
}

function toPortableRelativePath(fromDir: string, target: string): string {
  let rel = relative(fromDir, target).replaceAll("\\", "/")
  if (!rel.startsWith(".")) rel = `./${rel}`
  return rel
}
