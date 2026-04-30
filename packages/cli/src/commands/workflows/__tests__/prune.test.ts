import { describe, expect, it } from "vitest"
import { parseArgs } from "../../../lib/args.js"
import type { RunStore, StoredRun } from "../../../lib/run-store.js"
import { runWorkflowsPrune } from "../prune.js"

function mkRun(id: string, startedAt: number, overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    id,
    workflowId: "wf",
    status: "completed",
    startedAt,
    result: {},
    input: null,
    ...overrides,
  }
}

function memStore(runs: StoredRun[]): RunStore & { deleted: string[] } {
  const deleted: string[] = []
  let pool = [...runs]
  return {
    deleted,
    async save() {
      throw new Error("not used")
    },
    async list(filter = {}) {
      let out = [...pool]
      if (filter.workflowId) out = out.filter((r) => r.workflowId === filter.workflowId)
      if (filter.status) out = out.filter((r) => r.status === filter.status)
      out.sort((a, b) => b.startedAt - a.startedAt)
      if (filter.limit !== undefined) out = out.slice(0, filter.limit)
      return out
    },
    async get(id) {
      return pool.find((r) => r.id === id)
    },
    async delete(id) {
      const before = pool.length
      pool = pool.filter((r) => r.id !== id)
      if (pool.length < before) {
        deleted.push(id)
        return true
      }
      return false
    },
  }
}

describe("runWorkflowsPrune", () => {
  it("fails when neither --older-than nor --keep is provided", async () => {
    const store = memStore([mkRun("a", 1)])
    const out = await runWorkflowsPrune(parseArgs([]), { store })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.exitCode).toBe(2)
      expect(out.message).toMatch(/--older-than|--keep/)
    }
  })

  it("rejects a malformed --older-than value", async () => {
    const store = memStore([])
    const out = await runWorkflowsPrune(parseArgs(["--older-than", "yesterday"]), { store })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.exitCode).toBe(2)
  })

  it("--keep 2 retains the two most-recent runs and drops the rest", async () => {
    const runs = [mkRun("a", 100), mkRun("b", 200), mkRun("c", 300), mkRun("d", 400)]
    const store = memStore(runs)
    const out = await runWorkflowsPrune(parseArgs(["--keep", "2"]), { store })
    expect(out.ok).toBe(true)
    if (out.ok) {
      // Sorted most-recent first: [d, c, b, a]. Keep 2 → drop [b, a].
      expect(out.deleted.sort()).toEqual(["a", "b"])
    }
  })

  it("--older-than drops runs older than the cutoff", async () => {
    const now = 10_000
    const runs = [mkRun("old-1", 1_000), mkRun("old-2", 2_000), mkRun("recent", 9_000)]
    const store = memStore(runs)
    const out = await runWorkflowsPrune(parseArgs(["--older-than", "5s"]), {
      store,
      now: () => now,
    })
    expect(out.ok).toBe(true)
    if (out.ok) {
      // Cutoff = 10000 - 5000 = 5000. `startedAt <= 5000` → old-1 + old-2.
      expect(out.deleted.sort()).toEqual(["old-1", "old-2"])
    }
  })

  it("combines --older-than AND --keep (intersection)", async () => {
    // 6 runs, all older than 1m; --keep 2 retains 2 most-recent;
    // --older-than 1m keeps the newest + drops oldest 4.
    const now = 1_000_000
    const runs = [
      mkRun("r1", now - 10 * 60_000),
      mkRun("r2", now - 9 * 60_000),
      mkRun("r3", now - 8 * 60_000),
      mkRun("r4", now - 7 * 60_000),
      mkRun("r5", now - 6 * 60_000),
      mkRun("r6", now - 5 * 60_000),
    ]
    const store = memStore(runs)
    const out = await runWorkflowsPrune(parseArgs(["--keep", "2", "--older-than", "1m"]), {
      store,
      now: () => now,
    })
    expect(out.ok).toBe(true)
    if (out.ok) {
      // keep drops: tail after first 2 = [r4, r3, r2, r1]
      // older-than drops: every entry above started > 1m ago → all kept
      // intersection = [r4, r3, r2, r1]
      expect(out.deleted.sort()).toEqual(["r1", "r2", "r3", "r4"])
    }
  })

  it("respects --workflow filter", async () => {
    const runs = [
      mkRun("a", 100, { workflowId: "alpha" }),
      mkRun("b", 200, { workflowId: "beta" }),
      mkRun("c", 300, { workflowId: "beta" }),
    ]
    const store = memStore(runs)
    const out = await runWorkflowsPrune(parseArgs(["--keep", "0", "--workflow", "beta"]), { store })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.deleted.sort()).toEqual(["b", "c"])
  })

  it("respects --status filter", async () => {
    const runs = [mkRun("a", 100, { status: "completed" }), mkRun("b", 200, { status: "failed" })]
    const store = memStore(runs)
    const out = await runWorkflowsPrune(parseArgs(["--keep", "0", "--status", "failed"]), { store })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.deleted).toEqual(["b"])
  })

  it("--dry-run does not delete anything, returns candidates", async () => {
    const runs = [mkRun("a", 100), mkRun("b", 200)]
    const store = memStore(runs)
    const out = await runWorkflowsPrune(parseArgs(["--keep", "0", "--dry-run"]), { store })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.dryRun).toBe(true)
      expect(out.deleted).toEqual([])
      expect(out.candidates.map((c) => c.id).sort()).toEqual(["a", "b"])
    }
    expect(store.deleted).toEqual([])
  })

  it("errors when the store does not implement delete", async () => {
    const partialStore: RunStore = {
      async save() {
        throw new Error()
      },
      async list() {
        return []
      },
      async get() {
        return undefined
      },
    }
    const out = await runWorkflowsPrune(parseArgs(["--keep", "1"]), { store: partialStore })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.exitCode).toBe(1)
      expect(out.message).toMatch(/does not support delete/)
    }
  })
})
