// `voyant workflows run-detail <runId>`
//
// Loads a single stored run from the local store.

import type { ParsedArgs } from "../../lib/args.js"
import { createFsRunStore, type RunStore, type StoredRun } from "../../lib/run-store.js"

export interface RunDetailDeps {
  store: RunStore
}

export type RunDetailOutcome =
  | { ok: true; run: StoredRun }
  | { ok: false; message: string; exitCode: number }

export async function runWorkflowsRunDetail(
  args: ParsedArgs,
  deps: RunDetailDeps,
): Promise<RunDetailOutcome> {
  const [runId] = args.positional
  if (!runId) {
    return {
      ok: false,
      message: "voyant workflows run-detail: missing required <run-id>",
      exitCode: 2,
    }
  }

  try {
    const run = await deps.store.get(runId)
    if (!run) {
      return {
        ok: false,
        message:
          `voyant workflows run-detail: run "${runId}" not found in local store. ` +
          `Run \`voyant workflows runs\` to see saved ids.`,
        exitCode: 1,
      }
    }
    return { ok: true, run }
  } catch (err) {
    return {
      ok: false,
      message:
        `voyant workflows run-detail: failed to read run: ` +
        (err instanceof Error ? err.message : String(err)),
      exitCode: 1,
    }
  }
}

export async function defaultRunDetailDeps(): Promise<RunDetailDeps> {
  return { store: createFsRunStore() }
}
