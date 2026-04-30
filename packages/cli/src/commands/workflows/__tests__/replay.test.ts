import { describe, expect, it, vi } from "vitest"
import { parseArgs } from "../../../lib/args.js"
import type { RunStore, StoredRun } from "../../../lib/run-store.js"
import type { WorkflowDef } from "../list.js"
import { type ReplayDeps, runWorkflowsReplay } from "../replay.js"

function inMemoryStore(runs: Record<string, StoredRun> = {}): RunStore & { saves: StoredRun[] } {
  const saves: StoredRun[] = []
  return {
    saves,
    async save({ workflowId, input, result, entryFile, replayOf }) {
      const stored: StoredRun = {
        id: `run_test_${saves.length + 1}`,
        workflowId,
        status: typeof result.status === "string" ? result.status : "unknown",
        startedAt: 0,
        result,
        input,
        entryFile,
        replayOf,
      }
      saves.push(stored)
      return stored
    },
    async list() {
      return Object.values(runs)
    },
    async get(id) {
      return runs[id]
    },
  }
}

const fakeWorkflow: WorkflowDef = {
  id: "send-reminder",
  config: { run: async () => "ok" },
}

function makeDeps(overrides: Partial<ReplayDeps> = {}): ReplayDeps {
  return {
    store: inMemoryStore(),
    loadEntry: async () => {},
    getWorkflow: () => fakeWorkflow,
    runWorkflowForTest: async () => ({ status: "completed", output: "replayed" }),
    fileExists: async () => true,
    ...overrides,
  }
}

describe("runWorkflowsReplay", () => {
  it("fails when <run-id> is missing", async () => {
    const outcome = await runWorkflowsReplay(parseArgs([]), makeDeps())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toMatch(/missing required <run-id>/)
  })

  it("fails when the run id is not in the store", async () => {
    const outcome = await runWorkflowsReplay(
      parseArgs(["run_missing"]),
      makeDeps({ store: inMemoryStore({}) }),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toMatch(/not found in the local store/)
  })

  it("fails when the original run has no entry file and no --file is provided", async () => {
    const original: StoredRun = {
      id: "run_orig",
      workflowId: "send-reminder",
      status: "completed",
      startedAt: 0,
      result: {},
      input: { n: 1 },
      // no entryFile
    }
    const outcome = await runWorkflowsReplay(
      parseArgs(["run_orig"]),
      makeDeps({ store: inMemoryStore({ run_orig: original }) }),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toMatch(/does not have a stored entry file/)
  })

  it("fails when the stored entry file is missing and no --file override", async () => {
    const original: StoredRun = {
      id: "run_orig",
      workflowId: "send-reminder",
      status: "completed",
      startedAt: 0,
      result: {},
      input: {},
      entryFile: "/nonexistent/path.js",
    }
    const outcome = await runWorkflowsReplay(
      parseArgs(["run_orig"]),
      makeDeps({
        store: inMemoryStore({ run_orig: original }),
        fileExists: async () => false,
      }),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toMatch(/entry file not found/)
  })

  it("replays using the stored entry file and the original input", async () => {
    const original: StoredRun = {
      id: "run_orig",
      workflowId: "send-reminder",
      status: "completed",
      startedAt: 0,
      result: {},
      input: { customerId: "c1", token: "t1" },
      entryFile: "/fixtures/app.js",
    }
    const store = inMemoryStore({ run_orig: original })
    const run = vi.fn(async () => ({ status: "completed", output: "ok" }))
    const outcome = await runWorkflowsReplay(
      parseArgs(["run_orig"]),
      makeDeps({
        store,
        runWorkflowForTest: run as unknown as ReplayDeps["runWorkflowForTest"],
      }),
    )

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      // Same workflow + input, new result.
      expect(run).toHaveBeenCalledWith(fakeWorkflow, { customerId: "c1", token: "t1" }, {})
      expect(outcome.entryFile).toBe("/fixtures/app.js")
      expect(outcome.replayedFrom.id).toBe("run_orig")
      // Saved as a new run with replayOf pointing back.
      expect(store.saves).toHaveLength(1)
      expect(store.saves[0]!.replayOf).toBe("run_orig")
      expect(store.saves[0]!.input).toEqual({ customerId: "c1", token: "t1" })
      expect(store.saves[0]!.entryFile).toBe("/fixtures/app.js")
    }
  })

  it("honors --file override when explicitly provided", async () => {
    const original: StoredRun = {
      id: "run_orig",
      workflowId: "send-reminder",
      status: "completed",
      startedAt: 0,
      result: {},
      input: {},
      entryFile: "/old/path.js",
    }
    const outcome = await runWorkflowsReplay(
      parseArgs(["run_orig", "--file", "new/path.js"]),
      makeDeps({ store: inMemoryStore({ run_orig: original }) }),
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.entryFile).toContain("new/path.js")
      expect(outcome.entryFile).not.toBe("/old/path.js")
    }
  })

  it("skips save when --no-save is set", async () => {
    const original: StoredRun = {
      id: "run_orig",
      workflowId: "send-reminder",
      status: "completed",
      startedAt: 0,
      result: {},
      input: {},
      entryFile: "/fixtures/app.js",
    }
    const store = inMemoryStore({ run_orig: original })
    const outcome = await runWorkflowsReplay(
      parseArgs(["run_orig", "--no-save"]),
      makeDeps({ store }),
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.saved).toBeUndefined()
      expect(store.saves).toHaveLength(0)
    }
  })

  it("fails when the workflow is no longer registered in the reloaded entry", async () => {
    const original: StoredRun = {
      id: "run_orig",
      workflowId: "old-id",
      status: "completed",
      startedAt: 0,
      result: {},
      input: {},
      entryFile: "/fixtures/app.js",
    }
    const outcome = await runWorkflowsReplay(
      parseArgs(["run_orig"]),
      makeDeps({
        store: inMemoryStore({ run_orig: original }),
        getWorkflow: () => undefined,
      }),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.message).toMatch(/not registered/)
      expect(outcome.message).toContain("old-id")
    }
  })
})
