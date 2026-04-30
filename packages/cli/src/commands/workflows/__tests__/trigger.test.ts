import { describe, expect, it, vi } from "vitest"
import { parseArgs } from "../../../lib/args.js"
import { runWorkflowsTrigger, type TriggerDeps } from "../trigger.js"

function makeDeps(overrides: Partial<TriggerDeps> = {}): TriggerDeps {
  return {
    fetch: vi.fn(async () => ({
      status: 200,
      body: {
        saved: {
          id: "run_abc",
          workflowId: "greet",
          status: "completed",
          result: { output: { hi: "there" } },
        },
      },
    })),
    readFile: vi.fn(async () => "{}"),
    ...overrides,
  }
}

describe("runWorkflowsTrigger", () => {
  it("fails without a workflow id", async () => {
    const outcome = await runWorkflowsTrigger(parseArgs([]), makeDeps())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.exitCode).toBe(2)
      expect(outcome.message).toMatch(/missing required <workflow-id>/)
    }
  })

  it("POSTs {workflowId, input: undefined} when no input flag is given", async () => {
    const fetch = vi.fn(async () => ({
      status: 200,
      body: { saved: { id: "run_1", workflowId: "greet", status: "completed", result: {} } },
    }))
    await runWorkflowsTrigger(parseArgs(["greet"]), makeDeps({ fetch }))
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe("http://127.0.0.1:3232/api/runs")
    expect(init.method).toBe("POST")
    const parsed = JSON.parse(init.body)
    expect(parsed.workflowId).toBe("greet")
    expect(parsed.input).toBeUndefined()
  })

  it("honors --input with valid JSON", async () => {
    const fetch = vi.fn(async () => ({
      status: 200,
      body: { saved: { id: "run_1", workflowId: "greet", status: "completed", result: {} } },
    }))
    await runWorkflowsTrigger(
      parseArgs(["greet", "--input", '{"name":"ada"}']),
      makeDeps({ fetch }),
    )
    const parsed = JSON.parse(fetch.mock.calls[0]![1].body)
    expect(parsed.input).toEqual({ name: "ada" })
  })

  it("rejects --input with invalid JSON (exit 2)", async () => {
    const outcome = await runWorkflowsTrigger(
      parseArgs(["greet", "--input", "not json"]),
      makeDeps({ fetch: vi.fn() as unknown as TriggerDeps["fetch"] }),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.exitCode).toBe(2)
      expect(outcome.message).toMatch(/--input is not valid JSON/)
    }
  })

  it("reads --input-file and parses it", async () => {
    const readFile = vi.fn(async () => '{"fromFile":true}')
    const fetch = vi.fn(async () => ({
      status: 200,
      body: { saved: { id: "run_2", workflowId: "wf", status: "completed", result: {} } },
    }))
    await runWorkflowsTrigger(parseArgs(["wf", "--input-file", "fixtures/input.json"]), {
      readFile,
      fetch,
    })
    expect(readFile).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(fetch.mock.calls[0]![1].body)
    expect(parsed.input).toEqual({ fromFile: true })
  })

  it("rejects passing both --input and --input-file", async () => {
    const outcome = await runWorkflowsTrigger(
      parseArgs(["wf", "--input", "{}", "--input-file", "a.json"]),
      makeDeps(),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.exitCode).toBe(2)
      expect(outcome.message).toMatch(/only one of --input/)
    }
  })

  it("honors --url", async () => {
    const fetch = vi.fn(async () => ({
      status: 200,
      body: { saved: { id: "run_3", workflowId: "wf", status: "completed", result: {} } },
    }))
    await runWorkflowsTrigger(
      parseArgs(["wf", "--url", "http://10.0.0.1:9000"]),
      makeDeps({ fetch }),
    )
    expect(fetch.mock.calls[0]![0]).toBe("http://10.0.0.1:9000/api/runs")
  })

  it("strips trailing slash from --url", async () => {
    const fetch = vi.fn(async () => ({
      status: 200,
      body: { saved: { id: "run_4", workflowId: "wf", status: "completed", result: {} } },
    }))
    await runWorkflowsTrigger(
      parseArgs(["wf", "--url", "http://localhost:3232/"]),
      makeDeps({ fetch }),
    )
    expect(fetch.mock.calls[0]![0]).toBe("http://localhost:3232/api/runs")
  })

  it("returns the saved run on success", async () => {
    const outcome = await runWorkflowsTrigger(parseArgs(["greet"]), makeDeps())
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.saved.id).toBe("run_abc")
      expect(outcome.saved.status).toBe("completed")
      expect(outcome.url).toBe("http://127.0.0.1:3232")
    }
  })

  it("surfaces a 404 from the serve with the returned message", async () => {
    const outcome = await runWorkflowsTrigger(
      parseArgs(["ghost"]),
      makeDeps({
        fetch: vi.fn(async () => ({
          status: 404,
          body: { error: "trigger_failed", message: 'workflow "ghost" is not registered.' },
        })),
      }),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.exitCode).toBe(1)
      expect(outcome.message).toMatch(/404.*trigger_failed.*not registered/)
    }
  })

  it("maps 400 to exitCode 2", async () => {
    const outcome = await runWorkflowsTrigger(
      parseArgs(["wf"]),
      makeDeps({
        fetch: vi.fn(async () => ({
          status: 400,
          body: { error: "invalid_body", message: "workflowId required" },
        })),
      }),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.exitCode).toBe(2)
      expect(outcome.message).toMatch(/400.*invalid_body/)
    }
  })

  it("gives a connection-error hint when fetch throws", async () => {
    const outcome = await runWorkflowsTrigger(
      parseArgs(["wf"]),
      makeDeps({
        fetch: vi.fn(async () => {
          throw new Error("ECONNREFUSED")
        }),
      }),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.exitCode).toBe(1)
      expect(outcome.message).toMatch(/failed to reach .*ECONNREFUSED/)
      expect(outcome.message).toMatch(/voyant workflows serve|voyant dev/)
    }
  })

  it("errors when the serve returns an unexpected body shape", async () => {
    const outcome = await runWorkflowsTrigger(
      parseArgs(["wf"]),
      makeDeps({
        fetch: vi.fn(async () => ({ status: 200, body: { not: "the expected shape" } })),
      }),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toMatch(/unexpected body shape/)
  })
})
