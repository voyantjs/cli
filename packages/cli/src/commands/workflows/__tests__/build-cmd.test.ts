import { describe, expect, it, vi } from "vitest"
import { parseArgs } from "../../../lib/args.js"
import type { Bundler } from "../build.js"
import type { BuildCmdDeps } from "../build-cmd.js"
import { runWorkflowsBuild } from "../build-cmd.js"
import type { WorkflowDef } from "../list.js"

function okBundler(): Bundler {
  return {
    bundle: vi.fn(async () => ({ ok: true as const })),
  } as unknown as Bundler
}

function makeDeps(overrides: Partial<BuildCmdDeps> = {}): BuildCmdDeps {
  const workflows: WorkflowDef[] = [
    {
      id: "wf",
      config: {
        id: "wf",
        description: "x",
        run: async () => 1,
      } as unknown as WorkflowDef["config"],
    },
  ]
  return {
    bundler: okBundler(),
    importModule: vi.fn(async () => {}),
    resetRegistry: vi.fn(),
    getRegisteredWorkflows: () => workflows,
    writeOut: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    now: () => "2026-04-17T00:00:00.000Z",
    ...overrides,
  }
}

describe("runWorkflowsBuild", () => {
  it("fails without --file", async () => {
    const outcome = await runWorkflowsBuild(parseArgs([]), makeDeps())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toMatch(/missing required --file/)
  })

  it("bundles, imports, and writes a manifest on the happy path", async () => {
    const writeOut = vi.fn(async () => {})
    const mkdir = vi.fn(async () => {})
    const bundle = vi.fn(async () => ({ ok: true as const }))
    const importModule = vi.fn(async () => {})
    const resetRegistry = vi.fn()

    const outcome = await runWorkflowsBuild(
      parseArgs(["--file", "src/app.ts"]),
      makeDeps({
        bundler: { bundle } as unknown as Bundler,
        importModule,
        resetRegistry,
        writeOut,
        mkdir,
      }),
    )

    expect(outcome.ok).toBe(true)
    expect(mkdir).toHaveBeenCalledTimes(1)
    expect(bundle).toHaveBeenCalledTimes(1)
    // Registry is reset before importing the bundle so stale workflows
    // from the CLI process don't leak into the manifest.
    expect(resetRegistry).toHaveBeenCalledTimes(1)
    expect(importModule).toHaveBeenCalledTimes(1)
    // Manifest written once.
    expect(writeOut).toHaveBeenCalledTimes(1)
    const [manifestPath, content] = writeOut.mock.calls[0]!
    expect((manifestPath as string).endsWith("manifest.json")).toBe(true)
    expect((content as string).endsWith("\n")).toBe(true)
    const manifest = JSON.parse(content as string)
    expect(manifest.workflows[0]!.id).toBe("wf")
    if (outcome.ok) {
      expect(outcome.bundlePath.endsWith("bundle.mjs")).toBe(true)
      expect(outcome.manifestPath).toBe(manifestPath)
    }
  })

  it("honors --out for the output directory", async () => {
    const writeOut = vi.fn(async () => {})
    const mkdir = vi.fn(async () => {})
    const outcome = await runWorkflowsBuild(
      parseArgs(["--file", "src/app.ts", "--out", "tmp/out"]),
      makeDeps({ writeOut, mkdir }),
    )
    expect(outcome.ok).toBe(true)
    expect((mkdir.mock.calls[0]![0] as string).endsWith("/tmp/out")).toBe(true)
  })

  it("passes --minify and --no-sourcemap through to the bundler", async () => {
    const bundle = vi.fn(async () => ({ ok: true as const }))
    await runWorkflowsBuild(
      parseArgs(["--file", "src/app.ts", "--minify", "--no-sourcemap"]),
      makeDeps({ bundler: { bundle } as unknown as Bundler }),
    )
    const call = bundle.mock.calls[0]![0] as Parameters<Bundler["bundle"]>[0]
    expect(call.minify).toBe(true)
    expect(call.sourcemap).toBe(false)
  })

  it("passes --platform through to the bundler", async () => {
    const bundle = vi.fn(async () => ({ ok: true as const }))
    await runWorkflowsBuild(
      parseArgs(["--file", "src/app.ts", "--platform", "node"]),
      makeDeps({ bundler: { bundle } as unknown as Bundler }),
    )
    const call = bundle.mock.calls[0]![0] as Parameters<Bundler["bundle"]>[0]
    expect(call.platform).toBe("node")
  })

  it("reports a bundle failure as exitCode 1", async () => {
    const outcome = await runWorkflowsBuild(
      parseArgs(["--file", "src/app.ts"]),
      makeDeps({
        bundler: {
          bundle: async () => ({ ok: false as const, message: "syntax error at x" }),
        } as unknown as Bundler,
      }),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.exitCode).toBe(1)
      expect(outcome.message).toMatch(/bundle failed: syntax error at x/)
    }
  })

  it("reports an importModule failure as exitCode 1", async () => {
    const outcome = await runWorkflowsBuild(
      parseArgs(["--file", "src/app.ts"]),
      makeDeps({
        importModule: async () => {
          throw new Error("module load error")
        },
      }),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.message).toMatch(/loading bundle failed: module load error/)
    }
  })
})
