import { describe, expect, it } from "vitest"

import { buildDrizzleProxyCommand } from "../../src/commands/db.js"

describe("buildDrizzleProxyCommand", () => {
  it("defaults db generate to timestamp migration prefixes", () => {
    const proxy = buildDrizzleProxyCommand("/repo/templates/dmc", "generate", ["--name", "links"])

    expect(proxy.drizzleArgs).toEqual([
      "drizzle-kit",
      "generate",
      "--name",
      "links",
      "--prefix",
      "timestamp",
    ])
    expect(proxy.pnpmArgs).toEqual([
      "--dir",
      "/repo/templates/dmc",
      "exec",
      "drizzle-kit",
      "generate",
      "--name",
      "links",
      "--prefix",
      "timestamp",
    ])
  })

  it("preserves an explicit split --prefix", () => {
    const proxy = buildDrizzleProxyCommand("/repo/templates/dmc", "generate", [
      "--name",
      "links",
      "--prefix",
      "index",
    ])

    expect(proxy.drizzleArgs).toEqual([
      "drizzle-kit",
      "generate",
      "--name",
      "links",
      "--prefix",
      "index",
    ])
  })

  it("preserves an explicit equals --prefix", () => {
    const proxy = buildDrizzleProxyCommand("/repo/templates/dmc", "generate", [
      "--prefix=timestamp",
      "--name",
      "links",
    ])

    expect(proxy.drizzleArgs).toEqual([
      "drizzle-kit",
      "generate",
      "--prefix=timestamp",
      "--name",
      "links",
    ])
  })

  it("strips template selection before forwarding to drizzle-kit", () => {
    const proxy = buildDrizzleProxyCommand("/repo/templates/operator", "generate", [
      "--template",
      "templates/operator",
      "--name",
      "links",
      "--template=templates/dmc",
    ])

    expect(proxy.drizzleArgs).toEqual([
      "drizzle-kit",
      "generate",
      "--name",
      "links",
      "--prefix",
      "timestamp",
    ])
  })

  it("does not add generate-only defaults to other drizzle-kit subcommands", () => {
    const proxy = buildDrizzleProxyCommand("/repo/templates/dmc", "check", ["--config", "x.ts"])

    expect(proxy.drizzleArgs).toEqual(["drizzle-kit", "check", "--config", "x.ts"])
  })
})
