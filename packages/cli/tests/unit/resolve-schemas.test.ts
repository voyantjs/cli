import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { resolveSchemas } from "../../src/lib/resolve-schemas.js"

/**
 * Build a fake module by writing a `packages/<basename>/package.json` with the
 * given `voyant` field. The resolver's workspace fallback finds packages here
 * when `require.resolve` fails (i.e. they are not installed under
 * `node_modules/`), letting us exercise the closure logic without spinning up
 * a real install.
 */
function seedModule(
  cwd: string,
  name: string,
  voyant: { schema?: string; requiresSchemas?: string[] } | null,
): void {
  const basename = name.startsWith("@voyantjs/") ? name.slice("@voyantjs/".length) : name
  const dir = join(cwd, "packages", basename)
  mkdirSync(dir, { recursive: true })
  const pkg: Record<string, unknown> = { name, version: "0.0.0" }
  if (voyant) pkg.voyant = voyant
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2))
}

describe("resolveSchemas", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-resolve-"))
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ name: "consumer", version: "0.0.0" }, null, 2),
    )
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("returns the listed modules in dependency order with deps inserted first", () => {
    seedModule(tmp, "@voyantjs/db", { schema: "./schema", requiresSchemas: [] })
    seedModule(tmp, "@voyantjs/facilities", {
      schema: "./schema",
      requiresSchemas: ["@voyantjs/db"],
    })
    seedModule(tmp, "@voyantjs/bookings", {
      schema: "./schema",
      requiresSchemas: ["@voyantjs/db"],
    })
    seedModule(tmp, "@voyantjs/hospitality", {
      schema: "./schema",
      requiresSchemas: ["@voyantjs/db", "@voyantjs/facilities", "@voyantjs/bookings"],
    })

    const result = resolveSchemas({ modules: ["@voyantjs/hospitality"] }, { cwd: tmp })

    // Closure order: db before facilities/bookings, both before hospitality.
    expect(result).toEqual([
      "@voyantjs/db/schema",
      "@voyantjs/facilities/schema",
      "@voyantjs/bookings/schema",
      "@voyantjs/hospitality/schema",
    ])
  })

  it("dedupes shared deps reached through multiple paths", () => {
    seedModule(tmp, "@voyantjs/db", { schema: "./schema", requiresSchemas: [] })
    seedModule(tmp, "@voyantjs/facilities", {
      schema: "./schema",
      requiresSchemas: ["@voyantjs/db"],
    })
    seedModule(tmp, "@voyantjs/identity", {
      schema: "./schema",
      requiresSchemas: ["@voyantjs/db"],
    })
    seedModule(tmp, "@voyantjs/ground", {
      schema: "./schema",
      requiresSchemas: ["@voyantjs/db", "@voyantjs/facilities", "@voyantjs/identity"],
    })

    const result = resolveSchemas(
      { modules: ["@voyantjs/ground", "@voyantjs/facilities"] },
      { cwd: tmp },
    )

    expect(result.filter((s) => s === "@voyantjs/db/schema")).toHaveLength(1)
    expect(result.filter((s) => s === "@voyantjs/facilities/schema")).toHaveLength(1)
    // Order: dependencies precede dependents.
    expect(result.indexOf("@voyantjs/db/schema")).toBeLessThan(
      result.indexOf("@voyantjs/facilities/schema"),
    )
  })

  it("uses ./schema as the default subpath when manifest lacks `schema`", () => {
    seedModule(tmp, "@voyantjs/db", null)
    const result = resolveSchemas({ modules: ["@voyantjs/db"] }, { cwd: tmp })
    expect(result).toEqual(["@voyantjs/db/schema"])
  })

  it("throws on circular schema dependencies", () => {
    seedModule(tmp, "@voyantjs/a", { schema: "./schema", requiresSchemas: ["@voyantjs/b"] })
    seedModule(tmp, "@voyantjs/b", { schema: "./schema", requiresSchemas: ["@voyantjs/a"] })

    expect(() => resolveSchemas({ modules: ["@voyantjs/a"] }, { cwd: tmp })).toThrow(
      /Circular schema dependency/,
    )
  })

  it("respects ModuleEntry { resolve, options } shorthand", () => {
    seedModule(tmp, "@voyantjs/db", null)
    seedModule(tmp, "@voyantjs/crm", {
      schema: "./schema",
      requiresSchemas: ["@voyantjs/db"],
    })
    const result = resolveSchemas(
      {
        modules: [{ resolve: "@voyantjs/crm", options: { whatever: true } }],
      },
      { cwd: tmp },
    )
    expect(result).toEqual(["@voyantjs/db/schema", "@voyantjs/crm/schema"])
  })

  it("finds workspace packages from nested template directories", () => {
    seedModule(tmp, "@voyantjs/db", { schema: "./schema", requiresSchemas: [] })
    seedModule(tmp, "@voyantjs/accommodations", {
      schema: "./schema",
      requiresSchemas: ["@voyantjs/db"],
    })

    const nested = join(tmp, "apps", "dev")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "dev" }, null, 2))

    const result = resolveSchemas({ modules: ["@voyantjs/accommodations"] }, { cwd: nested })

    expect(result).toEqual(["@voyantjs/db/schema", "@voyantjs/accommodations/schema"])
  })

  it("includes schemas for extension subpath entries", () => {
    seedModule(tmp, "@voyantjs/db", { schema: "./schema", requiresSchemas: [] })
    seedModule(tmp, "@voyantjs/bookings", {
      schema: "./schema",
      requiresSchemas: ["@voyantjs/db"],
    })
    seedModule(tmp, "@voyantjs/products", {
      schema: "./schema",
      requiresSchemas: ["@voyantjs/db"],
    })

    const result = resolveSchemas(
      {
        modules: ["@voyantjs/bookings"],
        extensions: ["@voyantjs/products/booking-extension"],
      } as Parameters<typeof resolveSchemas>[0],
      { cwd: tmp },
    )

    expect(result).toEqual([
      "@voyantjs/db/schema",
      "@voyantjs/bookings/schema",
      "@voyantjs/products/schema",
    ])
  })

  it("dedupes extension schemas when the owning package is already a module", () => {
    seedModule(tmp, "@voyantjs/db", { schema: "./schema", requiresSchemas: [] })
    seedModule(tmp, "@voyantjs/products", {
      schema: "./schema",
      requiresSchemas: ["@voyantjs/db"],
    })

    const result = resolveSchemas(
      {
        modules: ["@voyantjs/products"],
        extensions: ["@voyantjs/products/booking-extension"],
      } as Parameters<typeof resolveSchemas>[0],
      { cwd: tmp },
    )

    expect(result).toEqual(["@voyantjs/db/schema", "@voyantjs/products/schema"])
  })
})
