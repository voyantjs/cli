// `voyant workflows runs [--workflow <id>] [--status <s>] [--limit N]`
//
// Lists saved runs from the local store. Human-readable table by
// default; `--json` emits the full stored objects.

import { getStringFlag, type ParsedArgs } from "../../lib/args.js"
import { createFsRunStore, type RunStore, type StoredRun } from "../../lib/run-store.js"

export interface RunsDeps {
  store: RunStore
}

export type RunsOutcome =
  | { ok: true; runs: StoredRun[] }
  | { ok: false; message: string; exitCode: number }

export async function runWorkflowsRuns(args: ParsedArgs, deps: RunsDeps): Promise<RunsOutcome> {
  const workflowId = getStringFlag(args, "workflow")
  const status = getStringFlag(args, "status")
  const limitStr = getStringFlag(args, "limit")
  const limit = limitStr !== undefined ? Number.parseInt(limitStr, 10) : undefined
  if (limit !== undefined && Number.isNaN(limit)) {
    return {
      ok: false,
      message: `voyant workflows runs: --limit must be a positive integer (got "${limitStr}")`,
      exitCode: 2,
    }
  }

  try {
    const runs = await deps.store.list({ workflowId, status, limit })
    return { ok: true, runs }
  } catch (err) {
    return {
      ok: false,
      message:
        `voyant workflows runs: failed to read run store: ` +
        (err instanceof Error ? err.message : String(err)),
      exitCode: 1,
    }
  }
}

export async function defaultRunsDeps(): Promise<RunsDeps> {
  return { store: createFsRunStore() }
}
