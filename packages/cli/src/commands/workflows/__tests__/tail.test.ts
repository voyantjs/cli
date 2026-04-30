import { describe, expect, it } from "vitest"
import { parseArgs } from "../../../lib/args.js"
import { runWorkflowsTail, type TailDeps } from "../tail.js"

function fakeSse(events: { event: string; data: unknown }[]): TailDeps["openSseStream"] {
  return (_url) => ({
    [Symbol.asyncIterator](): AsyncIterator<{ event: string; data: string }> {
      let i = 0
      return {
        async next() {
          if (i < events.length) {
            const ev = events[i++]!
            return {
              value: { event: ev.event, data: JSON.stringify(ev.data) },
              done: false,
            }
          }
          return { value: undefined, done: true }
        },
      }
    },
  })
}

function mkTailDeps(events: { event: string; data: unknown }[], written: string[]): TailDeps {
  return {
    openSseStream: fakeSse(events),
    write: (line) => {
      written.push(line)
    },
  }
}

describe("runWorkflowsTail", () => {
  it("fails without a run id", async () => {
    const written: string[] = []
    const outcome = await runWorkflowsTail(parseArgs([]), mkTailDeps([], written))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.exitCode).toBe(2)
  })

  it("returns not_found when hello reports run=null", async () => {
    const written: string[] = []
    const outcome = await runWorkflowsTail(
      parseArgs(["run_ghost"]),
      mkTailDeps([{ event: "hello", data: { run: null } }], written),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.exitCode).toBe(1)
      expect(outcome.message).toMatch(/run "run_ghost" not found/)
    }
  })

  it("exits immediately when hello reports a run that's already terminal", async () => {
    const written: string[] = []
    const outcome = await runWorkflowsTail(
      parseArgs(["run_done"]),
      mkTailDeps(
        [{ event: "hello", data: { run: { id: "run_done", status: "completed" } } }],
        written,
      ),
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.terminalStatus).toBe("completed")
      expect(outcome.chunksPrinted).toBe(0)
    }
  })

  it("prints text chunks in '[streamId] text' format", async () => {
    const written: string[] = []
    const outcome = await runWorkflowsTail(
      parseArgs(["run_live"]),
      mkTailDeps(
        [
          { event: "hello", data: { run: { id: "run_live", status: "running" } } },
          {
            event: "stream.chunk",
            data: {
              runId: "run_live",
              chunk: {
                streamId: "log",
                seq: 1,
                encoding: "text",
                chunk: "hello",
                final: false,
                at: 0,
              },
            },
          },
          {
            event: "stream.chunk",
            data: {
              runId: "run_live",
              chunk: {
                streamId: "log",
                seq: 2,
                encoding: "text",
                chunk: "world",
                final: false,
                at: 0,
              },
            },
          },
          {
            event: "updated",
            data: { kind: "updated", run: { id: "run_live", status: "completed" } },
          },
        ],
        written,
      ),
    )
    expect(outcome.ok).toBe(true)
    expect(written).toEqual(["[log] hello\n", "[log] world\n"])
    if (outcome.ok) expect(outcome.terminalStatus).toBe("completed")
  })

  it("filters by --stream", async () => {
    const written: string[] = []
    const outcome = await runWorkflowsTail(
      parseArgs(["run_live", "--stream", "log"]),
      mkTailDeps(
        [
          { event: "hello", data: { run: { id: "run_live", status: "running" } } },
          {
            event: "stream.chunk",
            data: {
              runId: "run_live",
              chunk: {
                streamId: "log",
                seq: 1,
                encoding: "text",
                chunk: "keep",
                final: false,
                at: 0,
              },
            },
          },
          {
            event: "stream.chunk",
            data: {
              runId: "run_live",
              chunk: {
                streamId: "other",
                seq: 1,
                encoding: "text",
                chunk: "drop",
                final: false,
                at: 0,
              },
            },
          },
          {
            event: "updated",
            data: { kind: "updated", run: { id: "run_live", status: "completed" } },
          },
        ],
        written,
      ),
    )
    expect(outcome.ok).toBe(true)
    expect(written).toEqual(["[log] keep\n"])
  })

  it("skips final-marker chunks (null payload with final: true)", async () => {
    const written: string[] = []
    await runWorkflowsTail(
      parseArgs(["run_x"]),
      mkTailDeps(
        [
          { event: "hello", data: { run: { id: "run_x", status: "running" } } },
          {
            event: "stream.chunk",
            data: {
              runId: "run_x",
              chunk: { streamId: "s", seq: 1, encoding: "text", chunk: "a", final: false, at: 0 },
            },
          },
          {
            event: "stream.chunk",
            data: {
              runId: "run_x",
              chunk: { streamId: "s", seq: 2, encoding: "text", chunk: null, final: true, at: 0 },
            },
          },
          {
            event: "updated",
            data: { kind: "updated", run: { id: "run_x", status: "completed" } },
          },
        ],
        written,
      ),
    )
    expect(written).toEqual(["[s] a\n"])
  })

  it("--json mode emits newline-delimited JSON records per chunk", async () => {
    const written: string[] = []
    await runWorkflowsTail(
      parseArgs(["run_live", "--json"]),
      mkTailDeps(
        [
          { event: "hello", data: { run: { id: "run_live", status: "running" } } },
          {
            event: "stream.chunk",
            data: {
              runId: "run_live",
              chunk: {
                streamId: "s",
                seq: 1,
                encoding: "json",
                chunk: { step: "fetch" },
                final: false,
                at: 0,
              },
            },
          },
          {
            event: "updated",
            data: { kind: "updated", run: { id: "run_live", status: "completed" } },
          },
        ],
        written,
      ),
    )
    expect(written).toHaveLength(1)
    const parsed = JSON.parse(written[0]!)
    expect(parsed).toEqual({ streamId: "s", seq: 1, chunk: { step: "fetch" } })
  })

  it("surfaces SSE read errors with a hint", async () => {
    const deps: TailDeps = {
      openSseStream: () => {
        throw new Error("ECONNREFUSED")
      },
      write: () => {},
    }
    const outcome = await runWorkflowsTail(parseArgs(["run_x"]), deps)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.exitCode).toBe(1)
      expect(outcome.message).toMatch(/ECONNREFUSED|voyant workflows serve|voyant dev/)
    }
  })
})
