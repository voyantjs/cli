import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  CONFIG_FILENAMES,
  loadVoyantConfigFile,
  resolveConfigPath,
} from "../../src/lib/config-loader.js"

describe("CONFIG_FILENAMES", () => {
  it("lists voyant.config.ts first for discoverability", () => {
    expect(CONFIG_FILENAMES[0]).toBe("voyant.config.ts")
  })

  it("includes all supported extensions", () => {
    expect(CONFIG_FILENAMES).toContain("voyant.config.ts")
    expect(CONFIG_FILENAMES).toContain("voyant.config.mjs")
    expect(CONFIG_FILENAMES).toContain("voyant.config.js")
    expect(CONFIG_FILENAMES).toContain("voyant.config.cjs")
  })
})

describe("resolveConfigPath", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-config-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("returns null when no config exists and walkUp is false", () => {
    expect(resolveConfigPath({ cwd: tmp, walkUp: false })).toBeNull()
  })

  it("finds a .mjs config at cwd", () => {
    const target = join(tmp, "voyant.config.mjs")
    writeFileSync(target, "export default {}\n")
    expect(resolveConfigPath({ cwd: tmp })).toBe(target)
  })

  it("finds a .js config at cwd", () => {
    const target = join(tmp, "voyant.config.js")
    writeFileSync(target, "module.exports = {}\n")
    expect(resolveConfigPath({ cwd: tmp })).toBe(target)
  })

  it("walks up to a parent directory", () => {
    const target = join(tmp, "voyant.config.mjs")
    writeFileSync(target, "export default {}\n")
    const nested = join(tmp, "a", "b", "c")
    mkdirSync(nested, { recursive: true })
    expect(resolveConfigPath({ cwd: nested })).toBe(target)
  })

  it("does not walk up when walkUp is false", () => {
    writeFileSync(join(tmp, "voyant.config.mjs"), "export default {}\n")
    const nested = join(tmp, "a")
    mkdirSync(nested, { recursive: true })
    expect(resolveConfigPath({ cwd: nested, walkUp: false })).toBeNull()
  })

  it("honors an explicit relative path", () => {
    const target = join(tmp, "custom.config.mjs")
    writeFileSync(target, "export default {}\n")
    expect(resolveConfigPath({ cwd: tmp, path: "custom.config.mjs" })).toBe(target)
  })

  it("honors an explicit absolute path", () => {
    const target = join(tmp, "custom.config.mjs")
    writeFileSync(target, "export default {}\n")
    expect(resolveConfigPath({ path: target })).toBe(target)
  })

  it("returns null for a missing explicit path", () => {
    expect(resolveConfigPath({ cwd: tmp, path: "missing.mjs" })).toBeNull()
  })

  it("prefers .ts over later extensions when multiple exist", () => {
    writeFileSync(join(tmp, "voyant.config.mjs"), "export default {}\n")
    // We don't write .ts here because loading it depends on Node's TS
    // support, but resolution alone should prefer it if present.
    const ts = join(tmp, "voyant.config.ts")
    writeFileSync(ts, "export default {}\n")
    expect(resolveConfigPath({ cwd: tmp })).toBe(ts)
  })
})

describe("loadVoyantConfigFile", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-config-load-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("loads a .mjs config and returns its default export", async () => {
    const target = join(tmp, "voyant.config.mjs")
    writeFileSync(
      target,
      `export default { modules: ["crm", "bookings"], deployment: "cloudflare-worker" }\n`,
    )
    const loaded = await loadVoyantConfigFile<{
      modules: string[]
      deployment: string
    }>(target)
    expect(loaded.path).toBe(target)
    expect(loaded.config.modules).toEqual(["crm", "bookings"])
    expect(loaded.config.deployment).toBe("cloudflare-worker")
  })

  it("throws when the file has no default export", async () => {
    const target = join(tmp, "voyant.config.mjs")
    writeFileSync(target, `export const foo = 1\n`)
    await expect(loadVoyantConfigFile(target)).rejects.toThrow(/no default export/)
  })

  it("throws a helpful error when the file fails to import", async () => {
    const target = join(tmp, "voyant.config.mjs")
    writeFileSync(target, `throw new Error("boom")\n`)
    await expect(loadVoyantConfigFile(target)).rejects.toThrow(/Failed to load voyant config/)
  })
})
