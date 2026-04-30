import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { configCommand } from "../../src/commands/config.js"

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

describe("configCommand", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-config-cmd-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("fails when no config file is found", async () => {
    const { ctx, stderr } = makeCtx([], tmp)
    const code = await configCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("No voyant.config.* found")
  })

  it("prints the config path with `config path`", async () => {
    const target = join(tmp, "voyant.config.mjs")
    writeFileSync(target, `export default { modules: ["crm"] }\n`)
    const { ctx, stdout } = makeCtx(["path"], tmp)
    const code = await configCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain(target)
  })

  it("shows a well-formed manifest with `config show`", async () => {
    const target = join(tmp, "voyant.config.mjs")
    writeFileSync(
      target,
      `export default {
        modules: ["crm", "bookings"],
        plugins: ["payload-cms"],
        deployment: "cloudflare-worker",
        admin: { enabled: true, path: "/app" },
        featureFlags: { links_enabled: true }
      }\n`,
    )
    const { ctx, stdout, stderr } = makeCtx(["show"], tmp)
    const code = await configCommand(ctx)
    expect(code).toBe(0)
    expect(stderr.join("")).toBe("")
    const out = stdout.join("")
    expect(out).toContain("Deployment: cloudflare-worker")
    expect(out).toContain("Modules (2):")
    expect(out).toContain("- crm")
    expect(out).toContain("- bookings")
    expect(out).toContain("Plugins (1):")
    expect(out).toContain("- payload-cms")
    expect(out).toContain("Admin: enabled=true path=/app")
    expect(out).toContain("Feature flags:")
    expect(out).toContain("- links_enabled: true")
  })

  it("defaults to `show` when no subcommand is given", async () => {
    const target = join(tmp, "voyant.config.mjs")
    writeFileSync(target, `export default { modules: ["crm"] }\n`)
    const { ctx, stdout } = makeCtx([], tmp)
    const code = await configCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("Modules (1):")
  })

  it("validates a well-formed manifest with `config validate`", async () => {
    const target = join(tmp, "voyant.config.mjs")
    writeFileSync(target, `export default { modules: ["crm"], deployment: "node" }\n`)
    const { ctx, stdout } = makeCtx(["validate"], tmp)
    const code = await configCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("voyant config ok:")
  })

  it("reports validation issues on a malformed manifest", async () => {
    const target = join(tmp, "voyant.config.mjs")
    writeFileSync(target, `export default { modules: ["crm", "crm"], admin: { enabled: "yes" } }\n`)
    const { ctx, stdout, stderr } = makeCtx(["validate"], tmp)
    const code = await configCommand(ctx)
    expect(code).toBe(1)
    expect(stdout.join("")).toBe("")
    const err = stderr.join("")
    expect(err).toContain("voyant config invalid")
    expect(err).toContain("Duplicate module")
    expect(err).toContain("admin.enabled")
  })

  it("honors --path to point at a specific file", async () => {
    const target = join(tmp, "custom.config.mjs")
    writeFileSync(target, `export default { modules: ["custom"] }\n`)
    const { ctx, stdout } = makeCtx(["show", "--path", target], tmp)
    const code = await configCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain("- custom")
  })

  it("fails fast when --path does not exist", async () => {
    const { ctx, stderr } = makeCtx(["show", "--path", join(tmp, "nope.mjs")], tmp)
    const code = await configCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("No voyant config found at")
  })

  it("rejects unknown subcommands", async () => {
    const target = join(tmp, "voyant.config.mjs")
    writeFileSync(target, `export default {}\n`)
    const { ctx, stderr } = makeCtx(["weird"], tmp)
    const code = await configCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Unknown config subcommand")
  })

  it("propagates load errors from the manifest file", async () => {
    const target = join(tmp, "voyant.config.mjs")
    writeFileSync(target, `throw new Error("broken")\n`)
    const { ctx, stderr } = makeCtx(["show"], tmp)
    const code = await configCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Failed to load voyant config")
  })

  it("surfaces validation issues even from `show`", async () => {
    const target = join(tmp, "voyant.config.mjs")
    writeFileSync(target, `export default { modules: "not-an-array" }\n`)
    const { ctx, stderr } = makeCtx(["show"], tmp)
    const code = await configCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Expected an array.")
  })
})
