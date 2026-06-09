import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { dbSchemasCommand } from "../../src/commands/db-schemas.js"

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
): void {
  const basename = name.startsWith("@voyantjs/") ? name.slice("@voyantjs/".length) : name
  const dir = join(cwd, "packages", basename)
  mkdirSync(join(dir, "src"), { recursive: true })
  writeFileSync(join(dir, "src/schema.ts"), "export const marker = true\n")
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
}

describe("dbSchemasCommand", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-db-schemas-"))
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "consumer" }, null, 2))
    seedModule(tmp, "@voyantjs/db", { schema: "./schema", requiresSchemas: [] })
    seedModule(tmp, "@voyantjs/crm", {
      schema: "./schema",
      requiresSchemas: ["@voyantjs/db"],
    })
    mkdirSync(join(tmp, "src/db"), { recursive: true })
    writeFileSync(join(tmp, "src/db/schema.ts"), "export const local = true\n")
    mkdirSync(join(tmp, "src/links"), { recursive: true })
    writeFileSync(
      join(tmp, "src/links/index.mjs"),
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
    writeFileSync(
      join(tmp, "voyant.config.mjs"),
      `export default { modules: ["@voyantjs/crm"], schemas: ["./src/db/schema.ts"] }\n`,
    )
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("prints and emits a generated schema manifest", async () => {
    const { ctx, stdout, stderr } = makeCtx(["--emit"], tmp)
    const code = await dbSchemasCommand(ctx)

    expect(code).toBe(0)
    expect(stderr.join("")).toBe("")
    expect(stdout.join("")).toContain("Wrote 1 link table schema(s)")
    expect(stdout.join("")).toContain("Wrote 4 schema entrypoint(s)")
    expect(stdout).toContain("@voyantjs/db/schema\n")
    expect(stdout).toContain("@voyantjs/crm/schema\n")
    expect(stdout).toContain("./src/db/schema.ts\n")
    expect(stdout).toContain("./drizzle.links.generated.ts\n")

    const generated = readFileSync(join(tmp, "drizzle.schemas.generated.ts"), "utf8")
    expect(generated).toContain("./packages/db/src/schema.ts")
    expect(generated).toContain("./packages/crm/src/schema.ts")
    expect(generated).toContain("./src/db/schema.ts")
    expect(generated).toContain("./drizzle.links.generated.ts")

    const generatedLinks = readFileSync(join(tmp, "drizzle.links.generated.ts"), "utf8")
    expect(generatedLinks).toContain('"crm_person_products_product"')
    expect(generatedLinks).toContain('uniqueIndex("crm_person_products_product_pair_idx")')
    expect(generatedLinks).toContain('index("crm_person_products_product_l_idx")')
  })
})
