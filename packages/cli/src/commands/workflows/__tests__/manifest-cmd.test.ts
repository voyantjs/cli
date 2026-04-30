import { describe, expect, it, vi } from "vitest"
import { parseArgs } from "../../../lib/args.js"
import type { WorkflowDef } from "../list.js"
import { type ManifestDeps, runWorkflowsManifest } from "../manifest-cmd.js"

function makeDeps(overrides: Partial<ManifestDeps> = {}): ManifestDeps {
  return {
    loadEntry: async () => {},
    getRegisteredWorkflows: () => [
      {
        id: "sample",
        config: {
          id: "sample",
          description: "a sample",
          run: async (_i: unknown, _c: unknown) => 1,
        },
      } as unknown as WorkflowDef,
    ],
    writeOut: async () => {},
    now: () => "2026-04-17T00:00:00.000Z",
    ...overrides,
  }
}

describe("runWorkflowsManifest", () => {
  it("fails without --file", async () => {
    const outcome = await runWorkflowsManifest(parseArgs([]), makeDeps())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toMatch(/missing required --file/)
  })

  it("surfaces a failed entry load as exitCode 1", async () => {
    const outcome = await runWorkflowsManifest(
      parseArgs(["--file", "bad.js"]),
      makeDeps({
        loadEntry: async () => {
          throw new Error("module not found")
        },
      }),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.exitCode).toBe(1)
      expect(outcome.message).toMatch(/module not found/)
    }
  })

  it("returns the manifest in-memory when --out is omitted", async () => {
    const outcome = await runWorkflowsManifest(parseArgs(["--file", "app.js"]), makeDeps())
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.wrotePath).toBeUndefined()
      expect(outcome.manifest.workflows[0]!.id).toBe("sample")
      expect(outcome.manifest.generatedAt).toBe("2026-04-17T00:00:00.000Z")
    }
  })

  it("writes the manifest to --out as formatted JSON + trailing newline", async () => {
    const writeOut = vi.fn(async () => {})
    const outcome = await runWorkflowsManifest(
      parseArgs(["--file", "app.js", "--out", "out.json"]),
      makeDeps({ writeOut }),
    )
    expect(outcome.ok).toBe(true)
    expect(writeOut).toHaveBeenCalledTimes(1)
    const [path, content] = writeOut.mock.calls[0]!
    expect(typeof path).toBe("string")
    expect((path as string).endsWith("out.json")).toBe(true)
    expect((content as string).endsWith("\n")).toBe(true)
    expect(JSON.parse(content as string).workflows[0]!.id).toBe("sample")
    if (outcome.ok) expect(outcome.wrotePath).toBe(path)
  })

  it("resolves --file against cwd for the manifest.entryFile field", async () => {
    const outcome = await runWorkflowsManifest(parseArgs(["--file", "relative/app.js"]), makeDeps())
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.manifest.entryFile).toMatch(/\/relative\/app\.js$/)
    }
  })
})
