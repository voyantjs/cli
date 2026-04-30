import { describe, expect, it, vi } from "vitest"
import { parseArgs } from "../../../lib/args.js"
import type { RunStore, StoredRun } from "../../../lib/run-store.js"
import type { WorkflowDef } from "../list.js"
import { type RunDeps, runWorkflowsRun } from "../run.js"

function makeDeps(overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    loadEntry: async () => {},
    getWorkflow: () => undefined,
    runWorkflowForTest: async () => ({
      status: "completed",
      output: "stub",
      steps: [],
      events: [],
      metadata: {},
      compensations: [],
      streams: {},
      invocations: 1,
    }),
    readFile: async () => "{}",
    ...overrides,
  }
}

function inMemoryStore(): RunStore & { saves: StoredRun[] } {
  const saves: StoredRun[] = []
  return {
    saves,
    async save({ workflowId, input, result }) {
      const stored: StoredRun = {
        id: `run_test_${saves.length + 1}`,
        workflowId,
        status: typeof result.status === "string" ? result.status : "unknown",
        startedAt: 0,
        result,
        input,
      }
      saves.push(stored)
      return stored
    },
    async list() {
      return saves
    },
    async get(id) {
      return saves.find((s) => s.id === id)
    },
  }
}

const fakeWorkflow: WorkflowDef = {
  id: "send-reminder",
  config: { run: async () => "ok" },
}

describe("runWorkflowsRun", () => {
  it("fails when <workflow-id> is missing", async () => {
    const outcome = await runWorkflowsRun(parseArgs(["--file", "./app.js"]), makeDeps())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toMatch(/missing required <workflow-id>/)
  })

  it("fails when --file is missing", async () => {
    const outcome = await runWorkflowsRun(parseArgs(["send-reminder"]), makeDeps())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toMatch(/missing required --file/)
  })

  it("fails when the workflow is not registered in the loaded file", async () => {
    const outcome = await runWorkflowsRun(
      parseArgs(["send-reminder", "--file", "./app.js"]),
      makeDeps({ getWorkflow: () => undefined }),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toMatch(/not registered/)
  })

  it("invokes runWorkflowForTest with no input when none is provided", async () => {
    const run = vi.fn(async () => ({ status: "completed", output: 42 }))
    const outcome = await runWorkflowsRun(
      parseArgs(["send-reminder", "--file", "./app.js"]),
      makeDeps({
        getWorkflow: () => fakeWorkflow,
        runWorkflowForTest: run as unknown as RunDeps["runWorkflowForTest"],
      }),
    )
    expect(outcome.ok).toBe(true)
    expect(run).toHaveBeenCalledWith(fakeWorkflow, undefined, {})
  })

  it("parses inline --input JSON and passes it to the harness", async () => {
    const run = vi.fn(async () => ({ status: "completed" }))
    const outcome = await runWorkflowsRun(
      parseArgs(["send-reminder", "--file", "./app.js", "--input", '{"bookingId":"b1"}']),
      makeDeps({
        getWorkflow: () => fakeWorkflow,
        runWorkflowForTest: run as unknown as RunDeps["runWorkflowForTest"],
      }),
    )
    expect(outcome.ok).toBe(true)
    expect(run).toHaveBeenCalledWith(fakeWorkflow, { bookingId: "b1" }, {})
  })

  it("reports an error when --input is not valid JSON", async () => {
    const outcome = await runWorkflowsRun(
      parseArgs(["send-reminder", "--file", "./app.js", "--input", "{not-json"]),
      makeDeps({ getWorkflow: () => fakeWorkflow }),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toMatch(/not valid JSON/)
  })

  it("reads --input-file from disk and parses JSON", async () => {
    const run = vi.fn(async () => ({ status: "completed" }))
    const outcome = await runWorkflowsRun(
      parseArgs(["send-reminder", "--file", "./app.js", "--input-file", "./in.json"]),
      makeDeps({
        getWorkflow: () => fakeWorkflow,
        readFile: async () => '{"fromFile":true}',
        runWorkflowForTest: run as unknown as RunDeps["runWorkflowForTest"],
      }),
    )
    expect(outcome.ok).toBe(true)
    expect(run).toHaveBeenCalledWith(fakeWorkflow, { fromFile: true }, {})
  })

  it("propagates errors thrown by the harness as a run failure", async () => {
    const outcome = await runWorkflowsRun(
      parseArgs(["send-reminder", "--file", "./app.js"]),
      makeDeps({
        getWorkflow: () => fakeWorkflow,
        runWorkflowForTest: async () => {
          throw new Error("harness blew up")
        },
      }),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toMatch(/harness blew up/)
  })

  it("saves the run to the store by default when one is provided", async () => {
    const store = inMemoryStore()
    const outcome = await runWorkflowsRun(
      parseArgs(["send-reminder", "--file", "./app.js", "--input", '{"x":1}']),
      makeDeps({
        getWorkflow: () => fakeWorkflow,
        store,
      }),
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.saved?.id).toMatch(/^run_/)
      expect(store.saves).toHaveLength(1)
      expect(store.saves[0]!.input).toEqual({ x: 1 })
      expect(store.saves[0]!.workflowId).toBe("send-reminder")
    }
  })

  it("skips saving when --no-save is passed", async () => {
    const store = inMemoryStore()
    const outcome = await runWorkflowsRun(
      parseArgs(["send-reminder", "--file", "./app.js", "--no-save"]),
      makeDeps({
        getWorkflow: () => fakeWorkflow,
        store,
      }),
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.saved).toBeUndefined()
      expect(store.saves).toHaveLength(0)
    }
  })
})
