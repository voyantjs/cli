// `voyant workflows trigger <id> [--input <json>] [--input-file <path>] [--url <url>]`
//
// POSTs a new run to a running serve's /api/runs endpoint. Use this
// instead of `voyant workflows run` when a serve is already up and
// you want the triggered run to show up in the dashboard + store.

import { readFile } from "node:fs/promises"
import { resolve as resolvePath } from "node:path"
import { getStringFlag, type ParsedArgs } from "../../lib/args.js"

const DEFAULT_URL = "http://127.0.0.1:3232"

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; body: unknown }>

export interface TriggerDeps {
  fetch: FetchLike
  readFile: (path: string) => Promise<string>
}

export interface SavedRun {
  id: string
  workflowId: string
  status: string
  result: Record<string, unknown>
}

export type TriggerOutcome =
  | { ok: true; url: string; saved: SavedRun }
  | { ok: false; message: string; exitCode: number }

export async function runWorkflowsTrigger(
  args: ParsedArgs,
  deps: TriggerDeps,
): Promise<TriggerOutcome> {
  const workflowId = args.positional[0]
  if (!workflowId) {
    return {
      ok: false,
      message: "voyant workflows trigger: missing required <workflow-id>",
      exitCode: 2,
    }
  }

  const input = await resolveInput(args, deps)
  if (!input.ok) return input

  const url = getStringFlag(args, "url") ?? DEFAULT_URL
  const endpoint = `${url.replace(/\/$/, "")}/api/runs`
  const body = JSON.stringify({ workflowId, input: input.value })

  let response: Awaited<ReturnType<FetchLike>>
  try {
    response = await deps.fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
  } catch (err) {
    return {
      ok: false,
      message:
        `voyant workflows trigger: failed to reach ${endpoint}: ` +
        (err instanceof Error ? err.message : String(err)) +
        `\nHint: start a serve with \`voyant workflows serve --file <bundle>\` or \`voyant dev --file <source>\`.`,
      exitCode: 1,
    }
  }

  if (response.status !== 200) {
    const errBody = response.body as { error?: string; message?: string } | undefined
    const msg = errBody?.message ?? `HTTP ${response.status}`
    const code = errBody?.error ? ` (${errBody.error})` : ""
    return {
      ok: false,
      message: `voyant workflows trigger: serve responded ${response.status}${code}: ${msg}`,
      exitCode: response.status === 400 ? 2 : 1,
    }
  }

  const parsed = response.body as { saved?: SavedRun }
  if (!parsed.saved || typeof parsed.saved.id !== "string") {
    return {
      ok: false,
      message: `voyant workflows trigger: serve returned an unexpected body shape`,
      exitCode: 1,
    }
  }
  return { ok: true, url, saved: parsed.saved }
}

// ---- helpers ----

async function resolveInput(
  args: ParsedArgs,
  deps: TriggerDeps,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string; exitCode: number }> {
  const inline = getStringFlag(args, "input")
  const file = getStringFlag(args, "input-file")
  if (inline !== undefined && file !== undefined) {
    return {
      ok: false,
      message: "voyant workflows trigger: pass only one of --input / --input-file",
      exitCode: 2,
    }
  }
  if (inline !== undefined) {
    try {
      return { ok: true, value: JSON.parse(inline) }
    } catch (err) {
      return {
        ok: false,
        message: `voyant workflows trigger: --input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: 2,
      }
    }
  }
  if (file !== undefined) {
    let text: string
    try {
      text = await deps.readFile(resolvePath(process.cwd(), file))
    } catch (err) {
      return {
        ok: false,
        message: `voyant workflows trigger: --input-file read failed: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: 1,
      }
    }
    try {
      return { ok: true, value: JSON.parse(text) }
    } catch (err) {
      return {
        ok: false,
        message: `voyant workflows trigger: --input-file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: 2,
      }
    }
  }
  // No input flag — pass `undefined` so workflows with `input?: void` still work.
  return { ok: true, value: undefined }
}

// ---- default deps ----

export async function defaultTriggerDeps(): Promise<TriggerDeps> {
  return {
    fetch: async (url, init) => {
      const res = await globalThis.fetch(url, init)
      let body: unknown
      const text = await res.text()
      try {
        body = text.length > 0 ? JSON.parse(text) : undefined
      } catch {
        body = text
      }
      return { status: res.status, body }
    },
    readFile: (path) => readFile(path, "utf8"),
  }
}
