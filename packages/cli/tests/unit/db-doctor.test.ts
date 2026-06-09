import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LinkDefinition } from "@voyantjs/core/links"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { dbDoctorCommand } from "../../src/commands/db-doctor.js"
import {
  defaultLinkSchemaEntry,
  renderLinkSchemaManifest,
} from "../../src/lib/link-schema-manifest.js"
import { renderSchemaManifest } from "../../src/lib/schema-manifest.js"

function makeCtx(argv: string[], cwd: string) {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    ctx: {
      argv,
      cwd,
      stdout: (chunk: string) => stdout.push(chunk),
      stderr: (chunk: string) => stderr.push(chunk),
    },
    stdout,
    stderr,
  }
}

function seedModule(
  cwd: string,
  name: string,
  voyant: { schema?: string; requiresSchemas?: string[] },
): string {
  const basename = name.startsWith("@voyantjs/") ? name.slice("@voyantjs/".length) : name
  const dir = join(cwd, "packages", basename)
  mkdirSync(join(dir, "src"), { recursive: true })
  const schema = voyant.schema ?? "./schema"
  const schemaSource =
    schema === "./reference/local-postgres"
      ? join(dir, "src/reference/local-postgres.ts")
      : join(dir, "src/schema.ts")
  mkdirSync(join(schemaSource, ".."), { recursive: true })
  writeFileSync(schemaSource, "export const marker = true\n")
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name,
        version: "0.0.0",
        type: "module",
        voyant,
      },
      null,
      2,
    ),
  )
  return schemaSource
}

function seedWorkspace(cwd: string, drizzleSchemas: string[]): void {
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "consumer" }, null, 2))
  writeFileSync(join(cwd, "voyant.config.mjs"), `export default { modules: ["@voyantjs/crm"] }\n`)
  writeFileSync(
    join(cwd, "drizzle.config.mjs"),
    `export default { schema: ${JSON.stringify(drizzleSchemas)}, out: "./migrations" }\n`,
  )

  const linksDir = join(cwd, "src/links")
  mkdirSync(linksDir, { recursive: true })
  writeFileSync(
    join(linksDir, "index.mjs"),
    `
const personLinkable = { module: "crm", entity: "person", table: "people" }
const productLinkable = { module: "products", entity: "product", table: "products" }
export const links = [{
  left: { linkable: personLinkable, isList: false },
  right: { linkable: productLinkable, isList: true },
  tableName: "crm_person_products_product",
  leftColumn: "crm_person_id",
  rightColumn: "products_product_id",
  cardinality: "one-to-many",
  deleteCascade: false,
}]
`,
  )

  const migrationsDir = join(cwd, "migrations")
  mkdirSync(join(migrationsDir, "meta"), { recursive: true })
  writeFileSync(join(migrationsDir, "0001_first.sql"), "-- first\n")
  writeFileSync(join(migrationsDir, "0001_second.sql"), "-- second\n")
  writeFileSync(
    join(migrationsDir, "meta/0000_snapshot.json"),
    JSON.stringify({ tables: { "public.people": {} } }, null, 2),
  )
}

function writeFreshGeneratedManifest(cwd: string): void {
  const generatedLinks = renderLinkSchemaManifest(testLinks(), {
    cwd,
    sourcePath: join(cwd, "src/links/index.mjs"),
  })
  writeFileSync(generatedLinks.path, generatedLinks.content)
  const generated = renderSchemaManifest(
    { modules: ["@voyantjs/crm"] },
    { cwd, additionalSchemas: [defaultLinkSchemaEntry()] },
  )
  writeFileSync(generated.path, generated.content)
}

function testLinks(): LinkDefinition[] {
  const personLinkable = { module: "crm", entity: "person", table: "people" }
  const productLinkable = { module: "products", entity: "product", table: "products" }
  return [
    {
      left: { linkable: personLinkable, isList: false },
      right: { linkable: productLinkable, isList: true },
      tableName: "crm_person_products_product",
      leftColumn: "crm_person_id",
      rightColumn: "products_product_id",
      cardinality: "one-to-many",
      deleteCascade: false,
    },
  ]
}

describe("dbDoctorCommand", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-db-doctor-"))
    seedModule(tmp, "@voyantjs/db", { schema: "./schema", requiresSchemas: [] })
    seedModule(tmp, "@voyantjs/crm", {
      schema: "./schema",
      requiresSchemas: ["@voyantjs/db"],
    })
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("reports schema, migration prefix, and link snapshot status without failing by default", async () => {
    seedWorkspace(tmp, [
      "./packages/db/src/schema.ts",
      "./packages/crm/src/schema.ts",
      "./drizzle.links.generated.ts",
    ])
    writeFreshGeneratedManifest(tmp)

    const { ctx, stdout, stderr } = makeCtx([], tmp)
    const code = await dbDoctorCommand(ctx)

    expect(code).toBe(0)
    expect(stderr.join("")).toBe("")
    const out = stdout.join("")
    expect(out).toContain("Schemas: 3 manifest-derived schema(s) match")
    expect(out).toContain("Generated link schema: drizzle.links.generated.ts is up to date")
    expect(out).toContain("Generated schema manifest: drizzle.schemas.generated.ts is up to date")
    expect(out).toContain('Duplicate migration prefix "0001"')
    expect(out).toContain("Link tables are missing from the latest Drizzle snapshot")
    expect(out).toContain("Report mode exits 0")
  })

  it("accepts an exact legacy duplicate migration prefix baseline", async () => {
    seedWorkspace(tmp, [
      "./packages/db/src/schema.ts",
      "./packages/crm/src/schema.ts",
      "./drizzle.links.generated.ts",
    ])
    writeFreshGeneratedManifest(tmp)
    writeFileSync(
      join(tmp, "migrations/duplicate-prefixes.baseline.json"),
      JSON.stringify(
        {
          version: 1,
          duplicates: [
            {
              prefix: "0001",
              files: ["0001_first.sql", "0001_second.sql"],
              reason: "Legacy concurrent migrations; do not rename applied migrations.",
            },
          ],
        },
        null,
        2,
      ),
    )

    const { ctx, stdout, stderr } = makeCtx([], tmp)
    const code = await dbDoctorCommand(ctx)

    expect(code).toBe(0)
    expect(stderr.join("")).toBe("")
    const out = stdout.join("")
    expect(out).toContain(
      "Migration prefixes: no unbaselined duplicates found (1 legacy duplicate prefix group(s) baselined).",
    )
    expect(out).not.toContain('Duplicate migration prefix "0001"')
  })

  it("exits non-zero with --fail-on-drift when report issues are present", async () => {
    seedWorkspace(tmp, [
      "./packages/db/src/schema.ts",
      "./packages/crm/src/schema.ts",
      "./drizzle.links.generated.ts",
    ])
    writeFreshGeneratedManifest(tmp)

    const { ctx, stdout } = makeCtx(["--fail-on-drift"], tmp)
    const code = await dbDoctorCommand(ctx)

    expect(code).toBe(1)
    expect(stdout.join("")).toContain("Exiting non-zero because --fail-on-drift was set")
  })

  it("reports schema drift between voyant.config and drizzle.config", async () => {
    seedWorkspace(tmp, ["./packages/db/src/schema.ts", "./drizzle.links.generated.ts"])
    writeFreshGeneratedManifest(tmp)

    const { ctx, stdout } = makeCtx([], tmp)
    const code = await dbDoctorCommand(ctx)

    expect(code).toBe(0)
    const out = stdout.join("")
    expect(out).toContain("Manifest-derived schemas are missing from drizzle.config")
    expect(out).toContain("packages/crm/src/schema.ts")
  })

  it("reports a missing generated schema manifest", async () => {
    seedWorkspace(tmp, ["./packages/db/src/schema.ts", "./packages/crm/src/schema.ts"])

    const { ctx, stdout } = makeCtx([], tmp)
    const code = await dbDoctorCommand(ctx)

    expect(code).toBe(0)
    expect(stdout.join("")).toContain(
      "Generated schema manifest is missing: drizzle.schemas.generated.ts",
    )
  })

  it("reports a stale generated schema manifest", async () => {
    seedWorkspace(tmp, ["./packages/db/src/schema.ts", "./packages/crm/src/schema.ts"])
    writeFileSync(join(tmp, "drizzle.schemas.generated.ts"), "export const schema = []\n")

    const { ctx, stdout } = makeCtx([], tmp)
    const code = await dbDoctorCommand(ctx)

    expect(code).toBe(0)
    expect(stdout.join("")).toContain(
      "Generated schema manifest is stale: drizzle.schemas.generated.ts",
    )
  })
})
