import { describe, expect, it, vi } from "vitest"
import type { RunStore, StoredRun } from "../run-store.js"
import { createStoreStream, diffSnapshots, type StoreEvent } from "../store-stream.js"

function mk(id: string, status: string, extra: Partial<StoredRun> = {}): StoredRun {
  return {
    id,
    workflowId: "wf",
    status,
    startedAt: 0,
    result: {},
    input: null,
    ...extra,
  }
}

function fakeStore(initial: StoredRun[]): RunStore & { set: (next: StoredRun[]) => void } {
  let current = initial
  return {
    set: (next) => {
      current = next
    },
    async list() {
      return current
    },
    async get(id) {
      return current.find((r) => r.id === id)
    },
    async save() {
      throw new Error("not used")
    },
  }
}

describe("diffSnapshots", () => {
  it("returns [] for identical snapshots", () => {
    const a = [mk("1", "running"), mk("2", "completed")]
    expect(diffSnapshots(a, a)).toEqual([])
  })

  it("detects added runs", () => {
    const a = [mk("1", "running")]
    const b = [mk("1", "running"), mk("2", "completed")]
    expect(diffSnapshots(a, b)).toEqual([{ kind: "added", run: mk("2", "completed") }])
  })

  it("detects removed runs", () => {
    const a = [mk("1", "running"), mk("2", "completed")]
    const b = [mk("1", "running")]
    expect(diffSnapshots(a, b)).toEqual([{ kind: "removed", runId: "2" }])
  })

  it("detects status changes", () => {
    const a = [mk("1", "running")]
    const b = [mk("1", "completed")]
    expect(diffSnapshots(a, b)).toEqual([{ kind: "updated", run: mk("1", "completed") }])
  })

  it("detects duration changes without status changes", () => {
    const a = [mk("1", "completed", { durationMs: 10 })]
    const b = [mk("1", "completed", { durationMs: 20 })]
    expect(diffSnapshots(a, b)).toHaveLength(1)
    expect(diffSnapshots(a, b)[0]!.kind).toBe("updated")
  })

  it("emits a mix of events in a single diff", () => {
    const a = [mk("1", "running"), mk("2", "running")]
    const b = [mk("1", "completed"), mk("3", "pending")]
    const events = diffSnapshots(a, b)
    const kinds = events.map((e) => e.kind).sort()
    expect(kinds).toEqual(["added", "removed", "updated"])
  })
})

describe("createStoreStream", () => {
  it("emits a snapshot on subscribe", async () => {
    const store = fakeStore([mk("1", "running")])
    const stream = createStoreStream(store, { intervalMs: 10_000 })
    const events: StoreEvent[] = []
    const unsubscribe = stream.subscribe((e) => events.push(e))
    await new Promise((r) => setTimeout(r, 10))
    expect(events.map((e) => e.kind)).toEqual(["snapshot"])
    if (events[0]!.kind === "snapshot") {
      expect(events[0]!.runs.map((r) => r.id)).toEqual(["1"])
    }
    unsubscribe()
    stream.stop()
  })

  it("emits added/updated/removed deltas on poll", async () => {
    const store = fakeStore([mk("1", "running")])
    const stream = createStoreStream(store, { intervalMs: 10_000 })
    const events: StoreEvent[] = []
    stream.subscribe((e) => events.push(e))
    await new Promise((r) => setTimeout(r, 10))
    events.length = 0 // drop the snapshot

    store.set([mk("1", "completed"), mk("2", "running")])
    await stream.poll()

    const kinds = events.map((e) => e.kind).sort()
    expect(kinds).toEqual(["added", "updated"])

    store.set([mk("1", "completed")])
    await stream.poll()
    expect(events[events.length - 1]).toEqual({ kind: "removed", runId: "2" })

    stream.stop()
  })

  it("tracks subscriber count and stops firing after unsubscribe", async () => {
    const store = fakeStore([mk("1", "running")])
    const stream = createStoreStream(store, { intervalMs: 10_000 })
    const a: StoreEvent[] = []
    const b: StoreEvent[] = []
    const ua = stream.subscribe((e) => a.push(e))
    const ub = stream.subscribe((e) => b.push(e))
    await new Promise((r) => setTimeout(r, 10))

    expect(stream.subscriberCount()).toBe(2)
    ua()
    expect(stream.subscriberCount()).toBe(1)

    store.set([mk("1", "completed")])
    a.length = 0
    b.length = 0
    await stream.poll()
    expect(a).toHaveLength(0) // unsubscribed
    expect(b).toHaveLength(1)

    ub()
    stream.stop()
  })

  it("starts the poll loop via the injected setInterval", () => {
    const store = fakeStore([])
    const setInt = vi.fn(() => 1 as unknown as NodeJS.Timeout)
    const clearInt = vi.fn()
    const stream = createStoreStream(store, {
      intervalMs: 1234,
      setInterval: setInt as unknown as typeof setInterval,
      clearInterval: clearInt as unknown as typeof clearInterval,
    })
    expect(setInt).toHaveBeenCalledWith(expect.any(Function), 1234)
    stream.stop()
    expect(clearInt).toHaveBeenCalledWith(1)
  })

  it("tolerates store.list rejections without crashing", async () => {
    const store: RunStore = {
      async list() {
        throw new Error("store unavailable")
      },
      async get() {
        return undefined
      },
      async save() {
        throw new Error("not used")
      },
    }
    const stream = createStoreStream(store, { intervalMs: 10_000 })
    await expect(stream.poll()).resolves.toBeUndefined()
    stream.stop()
  })
})
