import { describe, expect, it } from "vitest"
import { parseArgs } from "../../../lib/args.js"
import type { RunStore, StoredRun } from "../../../lib/run-store.js"
import { handleRequest, parseServeOptions, type RequestHandlerDeps } from "../serve.js"

const sample: StoredRun[] = [
  {
    id: "run_a",
    workflowId: "greet",
    status: "completed",
    startedAt: 1,
    input: null,
    result: { output: "hi" },
  },
  {
    id: "run_b",
    workflowId: "greet",
    status: "failed",
    startedAt: 2,
    input: null,
    result: { error: { message: "x" } },
  },
  { id: "run_c", workflowId: "ledger", status: "completed", startedAt: 3, input: null, result: {} },
]

function store(): RunStore {
  return {
    save: async () => sample[0]!,
    list: async (filter = {}) => {
      let out = [...sample]
      if (filter.workflowId) out = out.filter((r) => r.workflowId === filter.workflowId)
      if (filter.status) out = out.filter((r) => r.status === filter.status)
      out.sort((a, b) => b.startedAt - a.startedAt)
      if (filter.limit !== undefined) out = out.slice(0, filter.limit)
      return out
    },
    get: async (id) => sample.find((r) => r.id === id),
  }
}

const deps: RequestHandlerDeps = { store: store() }

describe("parseServeOptions", () => {
  it("defaults to 127.0.0.1:3232", () => {
    const o = parseServeOptions(parseArgs([]))
    expect(o.ok).toBe(true)
    if (o.ok) expect(o.options).toEqual({ port: 3232, host: "127.0.0.1" })
  })

  it("honors --port and --host", () => {
    const o = parseServeOptions(parseArgs(["--port", "4000", "--host", "0.0.0.0"]))
    expect(o.ok).toBe(true)
    if (o.ok) expect(o.options).toEqual({ port: 4000, host: "0.0.0.0" })
  })

  it("rejects invalid ports", () => {
    expect(parseServeOptions(parseArgs(["--port", "abc"])).ok).toBe(false)
    expect(parseServeOptions(parseArgs(["--port", "0"])).ok).toBe(false)
    expect(parseServeOptions(parseArgs(["--port", "70000"])).ok).toBe(false)
  })
})

describe("handleRequest", () => {
  it("returns a service summary at /", async () => {
    const res = await handleRequest({ method: "GET", url: "/" }, deps)
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toMatch(/json/)
    const body = JSON.parse(res.body as string)
    expect(body.service).toContain("voyant workflows serve")
    expect(body.endpoints).toEqual(["/api/runs", "/api/runs/:id"])
  })

  it("lists runs at /api/runs", async () => {
    const res = await handleRequest({ method: "GET", url: "/api/runs" }, deps)
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body as string)
    expect(body.runs).toHaveLength(3)
    // Most recent first.
    expect(body.runs[0].id).toBe("run_c")
  })

  it("filters by workflow query param", async () => {
    const res = await handleRequest({ method: "GET", url: "/api/runs?workflow=greet" }, deps)
    const body = JSON.parse(res.body as string)
    expect(body.runs.map((r: StoredRun) => r.id).sort()).toEqual(["run_a", "run_b"])
  })

  it("filters by status", async () => {
    const res = await handleRequest({ method: "GET", url: "/api/runs?status=failed" }, deps)
    const body = JSON.parse(res.body as string)
    expect(body.runs.map((r: StoredRun) => r.id)).toEqual(["run_b"])
  })

  it("honors limit", async () => {
    const res = await handleRequest({ method: "GET", url: "/api/runs?limit=1" }, deps)
    const body = JSON.parse(res.body as string)
    expect(body.runs).toHaveLength(1)
  })

  it("rejects invalid limit", async () => {
    const res = await handleRequest({ method: "GET", url: "/api/runs?limit=abc" }, deps)
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body as string).error).toBe("invalid_limit")
  })

  it("returns a single run at /api/runs/:id", async () => {
    const res = await handleRequest({ method: "GET", url: "/api/runs/run_b" }, deps)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body as string).run.id).toBe("run_b")
  })

  it("returns 404 for unknown run id", async () => {
    const res = await handleRequest({ method: "GET", url: "/api/runs/run_none" }, deps)
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body as string).error).toBe("not_found")
  })

  it("returns 404 for unknown routes", async () => {
    const res = await handleRequest({ method: "GET", url: "/unknown" }, deps)
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body as string).error).toBe("route_not_found")
  })

  it("rejects unsupported verbs (PUT/DELETE) with 405", async () => {
    const res = await handleRequest({ method: "DELETE", url: "/api/runs" }, deps)
    expect(res.status).toBe(405)
  })

  it("returns 404 (not 405) for POST to read-only paths", async () => {
    // POST is a valid verb (used for /api/runs/:id/replay and /api/runs),
    // so POSTing to a non-matching path is a route miss, not a method miss.
    const res = await handleRequest({ method: "POST", url: "/api/runs/run_a" }, deps)
    expect(res.status).toBe(404)
  })

  it("handles CORS preflight", async () => {
    const res = await handleRequest({ method: "OPTIONS", url: "/api/runs" }, deps)
    expect(res.status).toBe(204)
    expect(res.headers["access-control-allow-origin"]).toBe("*")
    expect(res.headers["access-control-allow-methods"]).toContain("GET")
  })

  it("sets CORS + cache headers on JSON responses", async () => {
    const res = await handleRequest({ method: "GET", url: "/api/runs" }, deps)
    expect(res.headers["access-control-allow-origin"]).toBe("*")
    expect(res.headers["cache-control"]).toBe("no-store")
  })
})

describe("handleRequest with static dashboard", () => {
  const files: Record<string, Uint8Array> = {
    "index.html": new TextEncoder().encode("<!doctype html><html><body>dashboard</body></html>"),
    "bundle.js": new TextEncoder().encode("// bundled js"),
    "bundle.js.map": new TextEncoder().encode('{"version":3}'),
  }
  const staticDeps: RequestHandlerDeps = {
    store: store(),
    hasStaticDashboard: true,
    readStatic: async (path) => files[path] ?? null,
  }

  it("serves index.html at /", async () => {
    const res = await handleRequest({ method: "GET", url: "/" }, staticDeps)
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toContain("text/html")
    expect(new TextDecoder().decode(res.body as Uint8Array)).toContain("dashboard")
  })

  it("serves static JS with the right mime type", async () => {
    const res = await handleRequest({ method: "GET", url: "/bundle.js" }, staticDeps)
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toContain("application/javascript")
  })

  it("falls back to JSON summary at / when the static bundle is missing", async () => {
    const res = await handleRequest(
      { method: "GET", url: "/" },
      { store: store(), hasStaticDashboard: true, readStatic: async () => null },
    )
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toContain("application/json")
    expect(JSON.parse(res.body as string).service).toContain("voyant workflows serve")
  })

  it("still returns JSON from /api/* when static is enabled", async () => {
    const res = await handleRequest({ method: "GET", url: "/api/runs" }, staticDeps)
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toContain("application/json")
  })

  it("rejects path-traversal attempts into the static root", async () => {
    const res = await handleRequest({ method: "GET", url: "/../../etc/passwd" }, staticDeps)
    expect(res.status).toBe(404)
  })
})

describe("handleRequest POST /api/runs/:id/replay", () => {
  it("returns 501 when replayRun is not provided", async () => {
    const res = await handleRequest(
      { method: "POST", url: "/api/runs/run_x/replay" },
      { store: store() },
    )
    expect(res.status).toBe(501)
    expect(JSON.parse(res.body as string).error).toBe("replay_not_supported")
  })

  it("returns 200 + saved run on successful replay", async () => {
    const replayRun: RequestHandlerDeps["replayRun"] = async (id) => ({
      ok: true,
      saved: {
        id: "run_new",
        workflowId: "wf",
        status: "completed",
        startedAt: 0,
        result: {},
        input: null,
        replayOf: id,
      },
    })
    const res = await handleRequest(
      { method: "POST", url: "/api/runs/run_orig/replay" },
      { store: store(), replayRun },
    )
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body as string)
    expect(body.saved.id).toBe("run_new")
    expect(body.saved.replayOf).toBe("run_orig")
  })

  it("returns 404 when replay reports exitCode 1 (runtime / not-found errors)", async () => {
    const replayRun: RequestHandlerDeps["replayRun"] = async () => ({
      ok: false,
      message: "run not found",
      exitCode: 1,
    })
    const res = await handleRequest(
      { method: "POST", url: "/api/runs/run_missing/replay" },
      { store: store(), replayRun },
    )
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body as string).error).toBe("replay_failed")
  })

  it("returns 400 when replay reports exitCode 2 (validation errors)", async () => {
    const replayRun: RequestHandlerDeps["replayRun"] = async () => ({
      ok: false,
      message: "missing --file",
      exitCode: 2,
    })
    const res = await handleRequest(
      { method: "POST", url: "/api/runs/run_x/replay" },
      { store: store(), replayRun },
    )
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body as string).message).toBe("missing --file")
  })

  it("returns 404 for POST to unknown routes", async () => {
    const res = await handleRequest(
      { method: "POST", url: "/api/something-else" },
      { store: store() },
    )
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body as string).error).toBe("route_not_found")
  })

  it("URL-decodes the run id before passing to replayRun", async () => {
    let captured = ""
    const replayRun: RequestHandlerDeps["replayRun"] = async (id) => {
      captured = id
      return {
        ok: true,
        saved: {
          id: "run_new",
          workflowId: "wf",
          status: "completed",
          startedAt: 0,
          result: {},
          input: null,
        },
      }
    }
    await handleRequest(
      { method: "POST", url: "/api/runs/run%5Forig/replay" },
      { store: store(), replayRun },
    )
    expect(captured).toBe("run_orig")
  })
})

describe("handleRequest GET /api/schedules", () => {
  it("returns an empty list when listSchedules is not provided", async () => {
    const res = await handleRequest({ method: "GET", url: "/api/schedules" }, deps)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body as string)).toEqual({ schedules: [] })
  })

  it("returns the schedules reported by listSchedules", async () => {
    const listSchedules: RequestHandlerDeps["listSchedules"] = () => [
      { workflowId: "wf-a", name: "daily", nextAt: 1_700_000_000_000, done: false },
      { workflowId: "wf-b", nextAt: Number.POSITIVE_INFINITY, done: true },
    ]
    const res = await handleRequest(
      { method: "GET", url: "/api/schedules" },
      { store: store(), listSchedules },
    )
    const body = JSON.parse(res.body as string)
    expect(body.schedules).toHaveLength(2)
    expect(body.schedules[0].workflowId).toBe("wf-a")
    expect(body.schedules[1].done).toBe(true)
  })
})

describe("handleRequest GET /api/workflows", () => {
  it("returns an empty list when listWorkflows is not provided", async () => {
    const res = await handleRequest({ method: "GET", url: "/api/workflows" }, deps)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body as string)).toEqual({ workflows: [] })
  })

  it("returns the workflows reported by listWorkflows", async () => {
    const listWorkflows: RequestHandlerDeps["listWorkflows"] = () => [
      { id: "greet", description: "says hi" },
      { id: "ledger" },
    ]
    const res = await handleRequest(
      { method: "GET", url: "/api/workflows" },
      { store: store(), listWorkflows },
    )
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body as string)).toEqual({
      workflows: [{ id: "greet", description: "says hi" }, { id: "ledger" }],
    })
  })
})

describe("handleRequest POST /api/runs", () => {
  it("returns 501 when triggerRun is not provided", async () => {
    const res = await handleRequest(
      { method: "POST", url: "/api/runs", body: JSON.stringify({ workflowId: "greet" }) },
      { store: store() },
    )
    expect(res.status).toBe(501)
    expect(JSON.parse(res.body as string).error).toBe("trigger_not_supported")
  })

  it("returns 200 + saved run on successful trigger", async () => {
    const triggerRun: RequestHandlerDeps["triggerRun"] = async ({ workflowId, input }) => ({
      ok: true,
      saved: {
        id: "run_new",
        workflowId,
        status: "completed",
        startedAt: 0,
        result: { input },
        input,
      },
    })
    const res = await handleRequest(
      {
        method: "POST",
        url: "/api/runs",
        body: JSON.stringify({ workflowId: "greet", input: { name: "world" } }),
      },
      { store: store(), triggerRun },
    )
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body as string)
    expect(body.saved.workflowId).toBe("greet")
    expect(body.saved.input).toEqual({ name: "world" })
  })

  it("returns 400 on invalid JSON body", async () => {
    const triggerRun: RequestHandlerDeps["triggerRun"] = async () => ({
      ok: true,
      saved: {
        id: "run_new",
        workflowId: "wf",
        status: "completed",
        startedAt: 0,
        result: {},
        input: null,
      },
    })
    const res = await handleRequest(
      { method: "POST", url: "/api/runs", body: "{not json" },
      { store: store(), triggerRun },
    )
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body as string).error).toBe("invalid_json")
  })

  it("returns 400 when workflowId is missing", async () => {
    const triggerRun: RequestHandlerDeps["triggerRun"] = async () => ({
      ok: true,
      saved: {
        id: "run_new",
        workflowId: "wf",
        status: "completed",
        startedAt: 0,
        result: {},
        input: null,
      },
    })
    const res = await handleRequest(
      { method: "POST", url: "/api/runs", body: JSON.stringify({ input: {} }) },
      { store: store(), triggerRun },
    )
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body as string).error).toBe("invalid_body")
  })

  it("returns 400 when triggerRun reports exitCode 2 (validation)", async () => {
    const triggerRun: RequestHandlerDeps["triggerRun"] = async () => ({
      ok: false,
      message: "bad input",
      exitCode: 2,
    })
    const res = await handleRequest(
      { method: "POST", url: "/api/runs", body: JSON.stringify({ workflowId: "greet" }) },
      { store: store(), triggerRun },
    )
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body as string).message).toBe("bad input")
  })

  it("returns 404 when triggerRun reports exitCode 1 (not found / runtime)", async () => {
    const triggerRun: RequestHandlerDeps["triggerRun"] = async () => ({
      ok: false,
      message: "not registered",
      exitCode: 1,
    })
    const res = await handleRequest(
      { method: "POST", url: "/api/runs", body: JSON.stringify({ workflowId: "nope" }) },
      { store: store(), triggerRun },
    )
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body as string).error).toBe("trigger_failed")
  })

  it("treats an empty body as an empty payload (missing workflowId → 400)", async () => {
    const triggerRun: RequestHandlerDeps["triggerRun"] = async () => ({
      ok: true,
      saved: {
        id: "run_new",
        workflowId: "wf",
        status: "completed",
        startedAt: 0,
        result: {},
        input: null,
      },
    })
    const res = await handleRequest(
      { method: "POST", url: "/api/runs" },
      { store: store(), triggerRun },
    )
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body as string).error).toBe("invalid_body")
  })
})

describe("handleRequest POST /api/runs/:id/cancel", () => {
  it("returns 501 when cancelRun is not provided", async () => {
    const res = await handleRequest(
      { method: "POST", url: "/api/runs/run_x/cancel" },
      { store: store() },
    )
    expect(res.status).toBe(501)
    expect(JSON.parse(res.body as string).error).toBe("cancel_not_supported")
  })

  it("returns 200 + saved run on successful cancel", async () => {
    const cancelRun: RequestHandlerDeps["cancelRun"] = async ({ runId }) => ({
      ok: true,
      saved: {
        id: runId,
        workflowId: "wf",
        status: "cancelled",
        startedAt: 0,
        result: { status: "cancelled" },
        input: null,
      },
    })
    const res = await handleRequest(
      { method: "POST", url: "/api/runs/run_abc/cancel" },
      { store: store(), cancelRun },
    )
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body as string)
    expect(body.saved.status).toBe("cancelled")
    expect(body.saved.id).toBe("run_abc")
  })

  it("returns 404 when cancelRun reports exitCode 1 (run missing)", async () => {
    const cancelRun: RequestHandlerDeps["cancelRun"] = async () => ({
      ok: false,
      message: "run not found",
      exitCode: 1,
    })
    const res = await handleRequest(
      { method: "POST", url: "/api/runs/run_none/cancel" },
      { store: store(), cancelRun },
    )
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body as string).error).toBe("cancel_failed")
  })

  it("returns 400 when cancelRun reports exitCode 2 (not parked)", async () => {
    const cancelRun: RequestHandlerDeps["cancelRun"] = async () => ({
      ok: false,
      message: "run is not parked",
      exitCode: 2,
    })
    const res = await handleRequest(
      { method: "POST", url: "/api/runs/run_done/cancel" },
      { store: store(), cancelRun },
    )
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body as string).message).toBe("run is not parked")
  })
})

describe("handleRequest POST waitpoint injection", () => {
  const savedWaiting: StoredRun = {
    id: "run_waiting",
    workflowId: "wf",
    status: "waiting",
    startedAt: 0,
    result: {},
    input: null,
  }

  it("returns 501 when injectWaitpoint is not provided", async () => {
    for (const url of [
      "/api/runs/run_waiting/events",
      "/api/runs/run_waiting/signals",
      "/api/runs/run_waiting/tokens/tok_1",
    ]) {
      const res = await handleRequest({ method: "POST", url, body: "{}" }, { store: store() })
      expect(res.status).toBe(501)
      expect(JSON.parse(res.body as string).error).toBe("inject_not_supported")
    }
  })

  it("events: 200 with saved run on a valid event injection", async () => {
    const injectWaitpoint: RequestHandlerDeps["injectWaitpoint"] = async (args) => ({
      ok: true,
      saved: { ...savedWaiting, status: "completed", id: args.runId },
    })
    const res = await handleRequest(
      {
        method: "POST",
        url: "/api/runs/run_waiting/events",
        body: JSON.stringify({ eventType: "greet", payload: { name: "x" } }),
      },
      { store: store(), injectWaitpoint },
    )
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body as string).saved.status).toBe("completed")
  })

  it("events: 400 when eventType is missing", async () => {
    const injectWaitpoint: RequestHandlerDeps["injectWaitpoint"] = async () => ({
      ok: true,
      saved: savedWaiting,
    })
    const res = await handleRequest(
      { method: "POST", url: "/api/runs/run_waiting/events", body: "{}" },
      { store: store(), injectWaitpoint },
    )
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body as string).error).toBe("invalid_body")
  })

  it("signals: forwards a SIGNAL injection", async () => {
    let captured: unknown
    const injectWaitpoint: RequestHandlerDeps["injectWaitpoint"] = async (args) => {
      captured = args.injection
      return { ok: true, saved: savedWaiting }
    }
    const res = await handleRequest(
      {
        method: "POST",
        url: "/api/runs/run_waiting/signals",
        body: JSON.stringify({ name: "approve", payload: { ok: true } }),
      },
      { store: store(), injectWaitpoint },
    )
    expect(res.status).toBe(200)
    expect(captured).toEqual({ kind: "SIGNAL", name: "approve", payload: { ok: true } })
  })

  it("tokens: forwards a MANUAL injection with the url-encoded token id", async () => {
    let captured: unknown
    const injectWaitpoint: RequestHandlerDeps["injectWaitpoint"] = async (args) => {
      captured = args.injection
      return { ok: true, saved: savedWaiting }
    }
    const res = await handleRequest(
      {
        method: "POST",
        url: "/api/runs/run_waiting/tokens/approval%2D42",
        body: JSON.stringify({ payload: "yes" }),
      },
      { store: store(), injectWaitpoint },
    )
    expect(res.status).toBe(200)
    expect(captured).toEqual({ kind: "MANUAL", tokenId: "approval-42", payload: "yes" })
  })

  it("400 on invalid JSON body", async () => {
    const injectWaitpoint: RequestHandlerDeps["injectWaitpoint"] = async () => ({
      ok: true,
      saved: savedWaiting,
    })
    const res = await handleRequest(
      { method: "POST", url: "/api/runs/run_waiting/events", body: "{bad" },
      { store: store(), injectWaitpoint },
    )
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body as string).error).toBe("invalid_json")
  })

  it("404 when injectWaitpoint reports exitCode 1 (run missing / not parked)", async () => {
    const injectWaitpoint: RequestHandlerDeps["injectWaitpoint"] = async () => ({
      ok: false,
      message: "run not found",
      exitCode: 1,
    })
    const res = await handleRequest(
      {
        method: "POST",
        url: "/api/runs/run_gone/events",
        body: JSON.stringify({ eventType: "greet" }),
      },
      { store: store(), injectWaitpoint },
    )
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body as string).error).toBe("inject_failed")
  })

  it("400 when injectWaitpoint reports exitCode 2 (validation)", async () => {
    const injectWaitpoint: RequestHandlerDeps["injectWaitpoint"] = async () => ({
      ok: false,
      message: "no pending waitpoint matches",
      exitCode: 2,
    })
    const res = await handleRequest(
      {
        method: "POST",
        url: "/api/runs/run_waiting/events",
        body: JSON.stringify({ eventType: "ghost" }),
      },
      { store: store(), injectWaitpoint },
    )
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body as string).message).toBe("no pending waitpoint matches")
  })
})
