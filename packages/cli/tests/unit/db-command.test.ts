import { describe, expect, it } from "vitest"

import { buildDrizzleArgs } from "../../src/commands/db.js"

describe("buildDrizzleArgs", () => {
  it("defaults generate to --prefix timestamp", () => {
    expect(buildDrizzleArgs("generate", [])).toEqual([
      "drizzle-kit",
      "generate",
      "--prefix",
      "timestamp",
    ])
  })

  it("forwards --name and still appends the timestamp prefix", () => {
    expect(buildDrizzleArgs("generate", ["--name", "add_widgets"])).toEqual([
      "drizzle-kit",
      "generate",
      "--name",
      "add_widgets",
      "--prefix",
      "timestamp",
    ])
  })

  it("does not override a caller-provided --prefix (space or = form)", () => {
    expect(buildDrizzleArgs("generate", ["--prefix", "index"])).toEqual([
      "drizzle-kit",
      "generate",
      "--prefix",
      "index",
    ])
    expect(buildDrizzleArgs("generate", ["--prefix=index"])).toEqual([
      "drizzle-kit",
      "generate",
      "--prefix=index",
    ])
  })

  it("strips the CLI-consumed --template (space and = forms)", () => {
    expect(
      buildDrizzleArgs("generate", ["--template", "templates/operator", "--name", "x"]),
    ).toEqual(["drizzle-kit", "generate", "--name", "x", "--prefix", "timestamp"])
    expect(buildDrizzleArgs("migrate", ["--template=templates/operator"])).toEqual([
      "drizzle-kit",
      "migrate",
    ])
  })

  it("does not add a prefix for non-generate subcommands", () => {
    expect(buildDrizzleArgs("migrate", [])).toEqual(["drizzle-kit", "migrate"])
    expect(buildDrizzleArgs("check", ["--verbose"])).toEqual(["drizzle-kit", "check", "--verbose"])
  })
})
