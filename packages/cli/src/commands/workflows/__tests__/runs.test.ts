import { describe, expect, it } from "vitest"
import { parseArgs } from "../../../lib/args.js"
import type { StoredRun } from "../../../lib/run-store.js"
import { type RunsDeps, runWorkflowsRuns } from "../runs.js"

function store(runs: StoredRun[]): RunsDeps["store"] {
  return {
    save: async () => runs[0]!,
    list: async (filter = {}) => {
      let out = runs
      if (filter.workflowId) out = out.filter((r) => r.workflowId === filter.workflowId)
      if (filter.status) out = out.filter((r) => r.status === filter.status)
      if (filter.limit !== undefined) out = out.slice(0, filter.limit)
      return out
    },
    get: async (id) => runs.find((r) => r.id === id),
  }
}

const sampleRuns: StoredRun[] = [
  { id: "run_a", workflowId: "greet", status: "completed", startedAt: 1, result: {}, input: null },
  { id: "run_b", workflowId: "greet", status: "failed", startedAt: 2, result: {}, input: null },
  { id: "run_c", workflowId: "ledger", status: "completed", startedAt: 3, result: {}, input: null },
]

describe("runWorkflowsRuns", () => {
  it("returns all runs when no filter is provided", async () => {
    const outcome = await runWorkflowsRuns(parseArgs([]), { store: store(sampleRuns) })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.runs).toHaveLength(3)
  })

  it("filters by --workflow", async () => {
    const outcome = await runWorkflowsRuns(parseArgs(["--workflow", "greet"]), {
      store: store(sampleRuns),
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.runs.map((r) => r.id)).toEqual(["run_a", "run_b"])
    }
  })

  it("filters by --status", async () => {
    const outcome = await runWorkflowsRuns(parseArgs(["--status", "failed"]), {
      store: store(sampleRuns),
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.runs.map((r) => r.id)).toEqual(["run_b"])
    }
  })

  it("applies --limit", async () => {
    const outcome = await runWorkflowsRuns(parseArgs(["--limit", "2"]), {
      store: store(sampleRuns),
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.runs).toHaveLength(2)
  })

  it("rejects non-numeric --limit", async () => {
    const outcome = await runWorkflowsRuns(parseArgs(["--limit", "abc"]), {
      store: store(sampleRuns),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toMatch(/must be a positive integer/)
  })
})
