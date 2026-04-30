// `voyant workflows tail <run-id> [--url <url>] [--stream <streamId>] [--json]`
//
// Connects to a running serve's per-run SSE endpoint and prints
// stream chunks to stdout as they arrive. Exits when the run
// reaches a terminal status.

import { getBooleanFlag, getStringFlag, type ParsedArgs } from "../../lib/args.js"

const DEFAULT_URL = "http://127.0.0.1:3232"

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "compensated",
  "compensation_failed",
])

export interface TailDeps {
  /**
   * Opens an SSE-like readable of the per-run endpoint. Returns an
   * iterator over parsed SSE events. Injectable for tests.
   */
  openSseStream(url: string): AsyncIterable<{ event: string; data: string }>
  /** Stdout writer. Injectable for tests. */
  write(line: string): void
}

export type TailOutcome =
  | { ok: true; terminalStatus: string; chunksPrinted: number }
  | { ok: false; message: string; exitCode: number }

export interface HelloEvent {
  run: {
    id: string
    status: string
    result?: {
      streams?: Record<
        string,
        {
          streamId: string
          seq: number
          encoding: "text" | "json" | "base64"
          chunk: unknown
          final: boolean
          at: number
        }[]
      >
    }
  } | null
}

export interface StreamChunkEvent {
  runId: string
  chunk: {
    streamId: string
    seq: number
    encoding: "text" | "json" | "base64"
    chunk: unknown
    final: boolean
    at: number
  }
}

export interface RunUpdateEvent {
  kind: "added" | "updated" | "removed"
  run?: { id: string; status: string }
  runId?: string
}

export async function runWorkflowsTail(args: ParsedArgs, deps: TailDeps): Promise<TailOutcome> {
  const runId = args.positional[0]
  if (!runId) {
    return {
      ok: false,
      message: "voyant workflows tail: missing required <run-id>",
      exitCode: 2,
    }
  }
  const url = getStringFlag(args, "url") ?? DEFAULT_URL
  const streamFilter = getStringFlag(args, "stream")
  const json = getBooleanFlag(args, "json")
  const endpoint = `${url.replace(/\/$/, "")}/api/runs/${encodeURIComponent(runId)}/stream`

  let chunksPrinted = 0
  let terminalStatus = ""

  try {
    for await (const ev of deps.openSseStream(endpoint)) {
      if (ev.event === "hello") {
        const payload = safeParse<HelloEvent>(ev.data)
        if (payload && payload.run === null) {
          return {
            ok: false,
            message: `voyant workflows tail: run "${runId}" not found`,
            exitCode: 1,
          }
        }
        // Replay existing chunks from the stored run's backlog before
        // entering the live-stream loop. Ordering: merge all
        // streamId buckets by `at` so the replay looks chronological.
        const streams = payload?.run?.result?.streams
        if (streams) {
          const all = Object.values(streams).flat()
          all.sort((a, b) => a.at - b.at)
          for (const chunk of all) {
            if (streamFilter && chunk.streamId !== streamFilter) continue
            if (chunk.final) continue
            chunksPrinted += 1
            if (json) {
              deps.write(
                `${JSON.stringify({ streamId: chunk.streamId, seq: chunk.seq, chunk: chunk.chunk })}\n`,
              )
            } else {
              const text =
                chunk.encoding === "text" && typeof chunk.chunk === "string"
                  ? chunk.chunk
                  : JSON.stringify(chunk.chunk)
              deps.write(`[${chunk.streamId}] ${text}\n`)
            }
          }
        }
        if (payload?.run && TERMINAL_STATUSES.has(payload.run.status)) {
          terminalStatus = payload.run.status
          break
        }
      } else if (ev.event === "stream.chunk") {
        const payload = safeParse<StreamChunkEvent>(ev.data)
        if (!payload) continue
        const { chunk } = payload
        if (streamFilter && chunk.streamId !== streamFilter) continue
        if (chunk.final) continue
        chunksPrinted += 1
        if (json) {
          deps.write(
            `${JSON.stringify({ streamId: chunk.streamId, seq: chunk.seq, chunk: chunk.chunk })}\n`,
          )
        } else {
          const text =
            chunk.encoding === "text" && typeof chunk.chunk === "string"
              ? chunk.chunk
              : JSON.stringify(chunk.chunk)
          deps.write(`[${chunk.streamId}] ${text}\n`)
        }
      } else if (ev.event === "added" || ev.event === "updated") {
        const payload = safeParse<RunUpdateEvent>(ev.data)
        if (payload?.run && TERMINAL_STATUSES.has(payload.run.status)) {
          terminalStatus = payload.run.status
          break
        }
      } else if (ev.event === "removed") {
        terminalStatus = "removed"
        break
      }
    }
  } catch (err) {
    return {
      ok: false,
      message:
        `voyant workflows tail: failed to read ${endpoint}: ` +
        (err instanceof Error ? err.message : String(err)) +
        `\nHint: start a serve with \`voyant workflows serve --file <bundle>\` or \`voyant dev --file <source>\`.`,
      exitCode: 1,
    }
  }

  return { ok: true, terminalStatus, chunksPrinted }
}

function safeParse<T>(data: string): T | undefined {
  try {
    return JSON.parse(data) as T
  } catch {
    return undefined
  }
}

// ---- default deps (real SSE + stdout) ----

export async function defaultTailDeps(): Promise<TailDeps> {
  return {
    openSseStream: (url) => sseFromFetch(url),
    write: (line) => process.stdout.write(line),
  }
}

/**
 * Minimal SSE parser over fetch's streaming body. Yields parsed
 * `{ event, data }` pairs. Not a full implementation — strips `id:` /
 * `retry:` fields, but covers our server's shape.
 */
async function* sseFromFetch(url: string): AsyncGenerator<{ event: string; data: string }> {
  const res = await globalThis.fetch(url, {
    headers: { accept: "text/event-stream" },
  })
  if (!res.ok || !res.body) {
    throw new Error(`SSE open failed: HTTP ${res.status}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buf += decoder.decode(value, { stream: true })
    // Events are terminated by blank lines (\n\n).
    let idx = buf.indexOf("\n\n")
    while (idx !== -1) {
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      let event = "message"
      let data = ""
      for (const line of raw.split("\n")) {
        if (line.startsWith(":")) continue // comment
        const colon = line.indexOf(":")
        if (colon === -1) continue
        const field = line.slice(0, colon)
        const value = line.slice(colon + 1).replace(/^ /, "")
        if (field === "event") event = value
        else if (field === "data") data += (data ? "\n" : "") + value
      }
      yield { event, data }
      idx = buf.indexOf("\n\n")
    }
  }
}
