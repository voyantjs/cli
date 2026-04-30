import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { execCommand } from "../../src/commands/exec.js"

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

describe("execCommand", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-exec-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("fails without a script argument", async () => {
    const { ctx, stderr } = makeCtx([], tmp)
    const code = await execCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Usage: voyant exec")
  })

  it("fails when the script does not exist", async () => {
    const { ctx, stderr } = makeCtx([join(tmp, "missing.ts")], tmp)
    const code = await execCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("Script not found")
  })

  it("runs a .mjs script to completion and returns its exit code", async () => {
    const script = join(tmp, "hello.mjs")
    writeFileSync(script, `console.log("hello from exec"); process.exit(0)\n`)
    const { ctx } = makeCtx([script], tmp)
    const code = await execCommand(ctx)
    expect(code).toBe(0)
  }, 20_000)

  it("runs a .ts script with Node's strip-types", async () => {
    const script = join(tmp, "typed.ts")
    writeFileSync(script, `const x: number = 42\nconsole.log("typed:", x)\nprocess.exit(0)\n`)
    const { ctx } = makeCtx([script], tmp)
    const code = await execCommand(ctx)
    expect(code).toBe(0)
  }, 20_000)

  it("rewrites .js → .ts specifiers in the loader hook", async () => {
    writeFileSync(join(tmp, "helper.ts"), `export const greeting = "hi"\n`)
    const script = join(tmp, "main.ts")
    writeFileSync(
      script,
      `import { greeting } from "./helper.js"\nconsole.log(greeting)\nprocess.exit(0)\n`,
    )
    const { ctx } = makeCtx([script], tmp)
    const code = await execCommand(ctx)
    expect(code).toBe(0)
  }, 20_000)

  it("propagates a non-zero exit code from the script", async () => {
    const script = join(tmp, "fail.mjs")
    writeFileSync(script, `process.exit(7)\n`)
    const { ctx } = makeCtx([script], tmp)
    const code = await execCommand(ctx)
    expect(code).toBe(7)
  }, 20_000)
})
