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
    "@voyantjs/foo-react",
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
    expect(out).toContain("@voyantjs/foo-react/admin")
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
      "A: admin entry @voyantjs/foo-react/admin (module @voyantjs/foo) is not imported",
    )
  })

  it("reports Finding B for imports whose module left the manifest", async () => {
    writeFixture(tmp)
    mkdirSync(join(tmp, "src"), { recursive: true })
    writeFileSync(
      join(tmp, "src", "admin.extensions.generated.ts"),
      [
        `import { createFooAdminExtension } from "@voyantjs/foo-react/admin"`,
        `import { createGoneAdminExtension } from "@voyantjs/gone-react/admin"`,
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
    expect(out).toContain("B: @voyantjs/gone-react/admin is imported")
    expect(out).not.toContain("B: @voyantjs/foo-react/admin")
    // foo is imported, so no Finding A for it either.
    expect(out).not.toContain("A: admin entry @voyantjs/foo-react/admin")
  })

  it("does not report Finding B when only the module's UI package is missing", async () => {
    writeFixture(tmp)
    // @voyantjs/bar stays in the manifest (module package present) but has
    // no resolvable bar-react package — a stale generated import for it is a
    // regenerate-needed situation, NOT "module left the manifest".
    writeFileSync(
      join(tmp, "voyant.config.ts"),
      `export default { modules: ["@voyantjs/foo", "@voyantjs/bar"] }\n`,
    )
    writePackage(tmp, "@voyantjs/bar", { exports: { ".": "./src/index.ts" } })
    mkdirSync(join(tmp, "src"), { recursive: true })
    writeFileSync(
      join(tmp, "src", "admin.extensions.generated.ts"),
      [
        `import { createFooAdminExtension } from "@voyantjs/foo-react/admin"`,
        `import { createBarAdminExtension } from "@voyantjs/bar-react/admin"`,
        `export const generatedAdminExtensionFactories = {`,
        `  foo: createFooAdminExtension,`,
        `  bar: createBarAdminExtension,`,
        `} as const`,
        ``,
      ].join("\n"),
    )
    const { ctx, stdout } = makeCtx([], tmp)
    const code = await adminDoctorCommand(ctx)
    expect(code).toBe(0)
    expect(stdout.join("")).not.toContain("B: @voyantjs/bar-react/admin")
  })

  it("reports Finding C when neither a route file nor a module entry binds a path", async () => {
    writeFixture(tmp)
    await adminGenerateCommand(makeCtx([], tmp).ctx)
    mkdirSync(join(tmp, "src", "routes", "_workspace"), { recursive: true })

    const missing = makeCtx([], tmp)
    expect(await adminDoctorCommand(missing.ctx)).toBe(0)
    expect(missing.stdout.join("")).toContain(
      "C: /foo (extension @voyantjs/foo-react/admin) is bound by no route file and " +
        "no entry in src/admin.routes.generated.tsx",
    )

    mkdirSync(join(tmp, "src", "routes", "_workspace", "foo"), { recursive: true })
    writeFileSync(join(tmp, "src", "routes", "_workspace", "foo", "index.tsx"), "export {}\n")
    const present = makeCtx([], tmp)
    expect(await adminDoctorCommand(present.ctx)).toBe(0)
    expect(present.stdout.join("")).not.toContain("C: /foo")
  })

  it("Finding C is satisfied by an entry in the code-assembled module (fileless routes)", async () => {
    writeFixture(tmp)
    await adminGenerateCommand(makeCtx([], tmp).ctx)
    // No route file anywhere — only the RFC §4.8 code-assembled module binds /foo.
    mkdirSync(join(tmp, "src", "routes", "_workspace"), { recursive: true })
    writeFileSync(
      join(tmp, "src", "admin.routes.generated.tsx"),
      [
        `// GENERATED by voyant admin generate --routes — do not edit.`,
        `export const FooIndexRoute = createRoute({`,
        `  getParentRoute: workspace,`,
        `  path: "/foo",`,
        `  ...adminExtensionRouteOptions(fooExtension, "foo-index", runtime),`,
        `})`,
        ``,
      ].join("\n"),
    )
    const { ctx, stdout } = makeCtx([], tmp)
    expect(await adminDoctorCommand(ctx)).toBe(0)
    const out = stdout.join("")
    expect(out).not.toContain("C: /foo")
    expect(out).toContain("0 finding(s)")
  })

  it("honors --routes-out for a non-default module path", async () => {
    writeFixture(tmp)
    await adminGenerateCommand(makeCtx([], tmp).ctx)
    mkdirSync(join(tmp, "src", "routes", "_workspace"), { recursive: true })
    const custom = join(tmp, "src", "admin-routes.custom.tsx")
    writeFileSync(custom, `const r = { path: "/foo" }\n`)
    const { ctx, stdout } = makeCtx(["--routes-out", custom], tmp)
    expect(await adminDoctorCommand(ctx)).toBe(0)
    expect(stdout.join("")).not.toContain("C: /foo")
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
    expect(out).toContain(
      "C: skipped route parity — no src/routes/_workspace directory and no " +
        "src/admin.routes.generated.tsx in host",
    )
    expect(out).toContain("D: skipped destination parity — no src/lib/admin-destinations.ts")
    expect(out).toContain("0 finding(s)")
  })

  describe("Finding D (destination parity)", () => {
    const DESTINATION_FOO_SOURCE = `
declare module "@voyantjs/admin" {
  interface AdminDestinations {
    "foo.list": Record<string, never>
    "foo.detail": { fooId: string }
  }
}
export function createFooAdminExtension(options = {}) {
  const { path = "/foo" } = options
  return { id: "foo", routes: [{ id: "foo-index", path }] }
}
`

    function writeDestinationsFixture(root: string, resolverKeys: ReadonlyArray<string>) {
      writeFileSync(
        join(root, "voyant.config.ts"),
        `export default { modules: ["@voyantjs/foo"] }\n`,
      )
      writePackage(root, "@voyantjs/foo", { exports: { ".": "./src/index.ts" } })
      writePackage(
        root,
        "@voyantjs/foo-react",
        { exports: { ".": "./src/index.ts", "./admin": "./src/admin/index.tsx" } },
        { "src/admin/index.tsx": DESTINATION_FOO_SOURCE },
      )
      mkdirSync(join(root, "src", "lib"), { recursive: true })
      writeFileSync(
        join(root, "src", "lib", "admin-destinations.ts"),
        [
          `import type { AdminDestinationResolvers } from "@voyantjs/admin"`,
          ``,
          `export const destinations = {`,
          ...resolverKeys.map((key) => `  "${key}": () => "/${key.split(".")[0]}",`),
          `} satisfies AdminDestinationResolvers`,
          ``,
        ].join("\n"),
      )
    }

    it("reports declared destinations that have no resolver", async () => {
      writeDestinationsFixture(tmp, ["foo.list"])
      const { ctx, stdout } = makeCtx([], tmp)
      expect(await adminDoctorCommand(ctx)).toBe(0)
      const out = stdout.join("")
      expect(out).toContain(
        `D: destination "foo.detail" declared by @voyantjs/foo-react/admin has no resolver`,
      )
      expect(out).not.toContain(`D: destination "foo.list"`)
    })

    it("reports resolvers that match no declared destination", async () => {
      writeDestinationsFixture(tmp, ["foo.list", "foo.detail", "gone.detail"])
      const { ctx, stdout } = makeCtx([], tmp)
      expect(await adminDoctorCommand(ctx)).toBe(0)
      const out = stdout.join("")
      expect(out).toContain(`D: resolver for "gone.detail"`)
      expect(out).toContain("matches no declared destination")
      expect(out).not.toContain(`D: destination "foo.detail"`)
      expect(out).not.toContain(`D: resolver for "foo.list"`)
    })

    it("is clean when declarations and resolvers match", async () => {
      writeDestinationsFixture(tmp, ["foo.list", "foo.detail"])
      // Compose first so Findings A/B are quiet and only D-parity is measured.
      await adminGenerateCommand(makeCtx([], tmp).ctx)
      const { ctx, stdout } = makeCtx([], tmp)
      expect(await adminDoctorCommand(ctx)).toBe(0)
      const out = stdout.join("")
      expect(out).not.toContain(" D: ")
      expect(out).toContain("0 finding(s)")
    })

    it("skips when the resolver file has no satisfies-marked map", async () => {
      writeDestinationsFixture(tmp, [])
      writeFileSync(
        join(tmp, "src", "lib", "admin-destinations.ts"),
        `export const destinations = { "foo.list": () => "/foo" }\n`,
      )
      const { ctx, stdout } = makeCtx([], tmp)
      expect(await adminDoctorCommand(ctx)).toBe(0)
      expect(stdout.join("")).toContain(
        "D: skipped destination parity — no `satisfies AdminDestinationResolvers` map",
      )
    })

    it("honors --destinations for a non-default resolver path", async () => {
      writeDestinationsFixture(tmp, ["foo.list", "foo.detail"])
      const custom = join(tmp, "src", "nav.ts")
      writeFileSync(
        custom,
        `export const map = { "foo.list": () => "/foo" } satisfies AdminDestinationResolvers\n`,
      )
      const { ctx, stdout } = makeCtx(["--destinations", custom], tmp)
      expect(await adminDoctorCommand(ctx)).toBe(0)
      expect(stdout.join("")).toContain(`D: destination "foo.detail" declared by`)
    })
  })
})
