import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { adminDoctorCommand } from "../../src/commands/admin-doctor.js"
import { adminGenerateCommand } from "../../src/commands/admin-generate.js"

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

function writePackage(
  root: string,
  name: string,
  pkg: Record<string, unknown>,
  files: Record<string, string> = {},
) {
  const dir = join(root, "node_modules", ...name.split("/"))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", ...pkg }))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, content)
  }
}

const FOO_ADMIN_SOURCE = `
export function createFooAdminExtension(options = {}) {
  const { path = "/foo" } = options
  return { id: "foo", routes: [{ id: "foo-index", path }] }
}
`

function writeFixture(root: string) {
  writeFileSync(join(root, "voyant.config.ts"), `export default { modules: ["@voyantjs/foo"] }\n`)
  writePackage(root, "@voyantjs/foo", { exports: { ".": "./src/index.ts" } })
  writePackage(
    root,
    "@voyantjs/foo-ui",
    { exports: { ".": "./src/index.ts", "./admin": "./src/admin/index.tsx" } },
    { "src/admin/index.tsx": FOO_ADMIN_SOURCE },
  )
}

describe("adminDoctorCommand", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "voyant-cli-admin-doctor-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("fails when no config file is found", async () => {
    const { ctx, stderr } = makeCtx([], tmp)
    const code = await adminDoctorCommand(ctx)
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("No voyant.config.* found")
  })

  it("reports Finding A when the generated file is missing", async () => {
    writeFixture(tmp)
    const { ctx, stdout } = makeCtx([], tmp)
    const code = await adminDoctorCommand(ctx)
    expect(code).toBe(0)
    const out = stdout.join("")
    expect(out).toContain("[admin-doctor] A: generated file")
    expect(out).toContain("@voyantjs/foo-ui/admin")
  })

  it("reports Finding A when an admin entry is not imported", async () => {
    writeFixture(tmp)
    mkdirSync(join(tmp, "src"), { recursive: true })
    writeFileSync(
      join(tmp, "src", "admin.extensions.generated.ts"),
      `export const generatedAdminExtensionFactories = {} as const\n`,
    )
    const { ctx, stdout } = makeCtx([], tmp)
    const code = await adminDoctorCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).toContain(
      "A: admin entry @voyantjs/foo-ui/admin (module @voyantjs/foo) is not imported",
    )
  })

  it("reports Finding B for imports whose module left the manifest", async () => {
    writeFixture(tmp)
    mkdirSync(join(tmp, "src"), { recursive: true })
    writeFileSync(
      join(tmp, "src", "admin.extensions.generated.ts"),
      [
        `import { createFooAdminExtension } from "@voyantjs/foo-ui/admin"`,
        `import { createGoneAdminExtension } from "@voyantjs/gone-ui/admin"`,
        `export const generatedAdminExtensionFactories = {`,
        `  foo: createFooAdminExtension,`,
        `  gone: createGoneAdminExtension,`,
        `} as const`,
        ``,
      ].join("\n"),
    )
    const { ctx, stdout } = makeCtx([], tmp)
    const code = await adminDoctorCommand(ctx)
    expect(code).toBe(0)
    const out = stdout.join("")
    expect(out).toContain("B: @voyantjs/gone-ui/admin is imported")
    expect(out).not.toContain("B: @voyantjs/foo-ui/admin")
    // foo is imported, so no Finding A for it either.
    expect(out).not.toContain("A: admin entry @voyantjs/foo-ui/admin")
  })

  it("reports Finding C when no route file matches a declared path", async () => {
    writeFixture(tmp)
    await adminGenerateCommand(makeCtx([], tmp).ctx)
    mkdirSync(join(tmp, "src", "routes", "_workspace"), { recursive: true })

    const missing = makeCtx([], tmp)
    expect(await adminDoctorCommand(missing.ctx)).toBe(0)
    expect(missing.stdout.join("")).toContain(
      "C: no route file found for /foo (extension @voyantjs/foo-ui/admin)",
    )

    mkdirSync(join(tmp, "src", "routes", "_workspace", "foo"), { recursive: true })
    writeFileSync(join(tmp, "src", "routes", "_workspace", "foo", "index.tsx"), "export {}\n")
    const present = makeCtx([], tmp)
    expect(await adminDoctorCommand(present.ctx)).toBe(0)
    expect(present.stdout.join("")).not.toContain("C: no route file found")
  })

  it("is clean after voyant admin generate (and always exits 0)", async () => {
    writeFixture(tmp)
    await adminGenerateCommand(makeCtx([], tmp).ctx)
    const { ctx, stdout } = makeCtx([], tmp)
    const code = await adminDoctorCommand(ctx)
    expect(code).toBe(0)
    const out = stdout.join("")
    expect(out).not.toContain(" A: ")
    expect(out).not.toContain(" B: ")
    expect(out).toContain("C: skipped route parity — no src/routes directory")
    expect(out).toContain("0 finding(s)")
  })
})
