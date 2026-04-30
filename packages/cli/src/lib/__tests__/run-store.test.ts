import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createFsRunStore } from "../run-store.js"

let tmp: string
let timeCounter = 1_700_000_000_000
let randCounter = 0

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "voyant-store-test-"))
  timeCounter = 1_700_000_000_000
  randCounter = 0
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function makeStore() {
  return createFsRunStore({
    rootDir: tmp,
    now: () => ++timeCounter,
    random: () => {
      randCounter += 1
      return randCounter * 0.0001
    },
  })
}

describe("createFsRunStore", () => {
  it("saves and retrieves a run by id", async () => {
    const store = makeStore()
    const saved = await store.save({
      workflowId: "greet",
      input: { name: "world" },
      result: {
        status: "completed",
        output: { message: "hi" },
        startedAt: 1_700_000_000_100,
        completedAt: 1_700_000_000_200,
      },
    })

    expect(saved.id).toMatch(/^run_/)
    expect(saved.workflowId).toBe("greet")
    expect(saved.status).toBe("completed")
    expect(saved.durationMs).toBe(100)

    const fetched = await store.get(saved.id)
    expect(fetched?.id).toBe(saved.id)
    expect(fetched?.input).toEqual({ name: "world" })
    expect((fetched?.result as { output?: unknown }).output).toEqual({ message: "hi" })
  })

  it("lists runs most-recent-first", async () => {
    const store = makeStore()
    for (let i = 0; i < 3; i++) {
      await store.save({
        workflowId: "greet",
        input: { i },
        result: { status: "completed", startedAt: 1_700_000_000_000 + i * 1000 },
      })
    }

    const listed = await store.list()
    expect(listed).toHaveLength(3)
    // Descending by startedAt.
    expect(listed[0]!.input).toEqual({ i: 2 })
    expect(listed[2]!.input).toEqual({ i: 0 })
  })

  it("filters by workflow id, status, and limit", async () => {
    const store = makeStore()
    await store.save({
      workflowId: "greet",
      input: null,
      result: { status: "completed", startedAt: 1 },
    })
    await store.save({
      workflowId: "greet",
      input: null,
      result: { status: "failed", startedAt: 2 },
    })
    await store.save({
      workflowId: "ledger",
      input: null,
      result: { status: "completed", startedAt: 3 },
    })
    await store.save({
      workflowId: "greet",
      input: null,
      result: { status: "completed", startedAt: 4 },
    })

    expect((await store.list({ workflowId: "greet" })).length).toBe(3)
    expect((await store.list({ status: "completed" })).length).toBe(3)
    expect((await store.list({ workflowId: "greet", status: "completed" })).length).toBe(2)
    expect((await store.list({ limit: 2 })).length).toBe(2)
  })

  it("returns undefined for a missing run id", async () => {
    const store = makeStore()
    expect(await store.get("run_does_not_exist")).toBeUndefined()
  })

  it("handles a missing root dir by returning []", async () => {
    const store = createFsRunStore({ rootDir: join(tmp, "never-created") })
    expect(await store.list()).toEqual([])
  })
})
