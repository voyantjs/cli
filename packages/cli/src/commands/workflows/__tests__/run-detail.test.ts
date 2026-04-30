import { describe, expect, it } from "vitest"
import { parseArgs } from "../../../lib/args.js"
import type { StoredRun } from "../../../lib/run-store.js"
import { type RunDetailDeps, runWorkflowsRunDetail } from "../run-detail.js"

function store(runs: Record<string, StoredRun>): RunDetailDeps["store"] {
  return {
    save: async () => {
      throw new Error("not used")
    },
    list: async () => [],
    get: async (id) => runs[id],
  }
}

describe("runWorkflowsRunDetail", () => {
  it("fails when <run-id> is missing", async () => {
    const outcome = await runWorkflowsRunDetail(parseArgs([]), { store: store({}) })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toMatch(/missing required <run-id>/)
  })

  it("fails when the run id is not found", async () => {
    const outcome = await runWorkflowsRunDetail(parseArgs(["run_unknown"]), { store: store({}) })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.message).toMatch(/run "run_unknown" not found/)
      expect(outcome.exitCode).toBe(1)
    }
  })

  it("returns the stored run when found", async () => {
    const run: StoredRun = {
      id: "run_abc",
      workflowId: "greet",
      status: "completed",
      startedAt: 1,
      result: { status: "completed", output: "hi" },
      input: { name: "world" },
    }
    const outcome = await runWorkflowsRunDetail(parseArgs(["run_abc"]), {
      store: store({ run_abc: run }),
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.run.id).toBe("run_abc")
      expect(outcome.run.workflowId).toBe("greet")
    }
  })
})
