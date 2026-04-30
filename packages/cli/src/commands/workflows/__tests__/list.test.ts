import { describe, expect, it } from "vitest"
import { parseArgs } from "../../../lib/args.js"
import { type ListDeps, runWorkflowsList, type WorkflowDef } from "../list.js"

function makeDeps(workflows: WorkflowDef[] = [], loadThrows?: Error): ListDeps {
  return {
    loadEntry: async () => {
      if (loadThrows) throw loadThrows
    },
    getRegisteredWorkflows: () => workflows,
  }
}

function mk(id: string, extra: Partial<WorkflowDef["config"]> = {}): WorkflowDef {
  return {
    id,
    config: {
      run: async () => undefined,
      ...extra,
    },
  }
}

describe("runWorkflowsList", () => {
  it("fails when --file is missing", async () => {
    const outcome = await runWorkflowsList(parseArgs([]), makeDeps())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.message).toMatch(/missing required --file/)
      expect(outcome.exitCode).toBe(2)
    }
  })

  it("loads the entry file and returns the registered workflows", async () => {
    const outcome = await runWorkflowsList(
      parseArgs(["--file", "./app.js"]),
      makeDeps([
        mk("send-reminder", { description: "Send a booking reminder" }),
        mk("settle-ledger", { description: "Nightly settlement" }),
      ]),
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.workflows).toEqual([
        {
          id: "send-reminder",
          description: "Send a booking reminder",
          schedules: 0,
          hasCompensation: false,
        },
        {
          id: "settle-ledger",
          description: "Nightly settlement",
          schedules: 0,
          hasCompensation: false,
        },
      ])
    }
  })

  it("counts scheduled workflows correctly (single vs array)", async () => {
    const outcome = await runWorkflowsList(
      parseArgs(["--file", "./app.js"]),
      makeDeps([
        mk("single", { schedule: { cron: "0 * * * *" } }),
        mk("triple", { schedule: [{ cron: "0 0 * * *" }, { every: "15m" }, { every: "1h" }] }),
        mk("none"),
      ]),
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.workflows.map((w) => [w.id, w.schedules])).toEqual([
        ["single", 1],
        ["triple", 3],
        ["none", 0],
      ])
    }
  })

  it("propagates entry-load errors as a CLI failure", async () => {
    const outcome = await runWorkflowsList(
      parseArgs(["--file", "./broken.js"]),
      makeDeps([], new Error("Unexpected token in ./broken.js")),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.message).toContain("Unexpected token")
      expect(outcome.exitCode).toBe(1)
    }
  })
})
