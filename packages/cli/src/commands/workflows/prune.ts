// `voyant workflows prune` — delete stored runs from .voyant/runs/.
//
// Retention knobs:
//   --older-than <duration>  drop runs that started more than N ago
//   --keep <N>               keep only the N most recent (per filter)
//   --status <s>             restrict pruning to runs with this status
//   --workflow <id>          restrict pruning to one workflow
//   --dry-run                print what would be deleted, don't touch disk
//
// At least one of --older-than / --keep must be supplied so invoking
// the command accidentally doesn't wipe the whole store. `--dry-run`
// is the recommended way to preview.

import { getBooleanFlag, getNumberFlag, getStringFlag, type ParsedArgs } from "../../lib/args.js"
import { createFsRunStore, type RunStore, type StoredRun } from "../../lib/run-store.js"

export interface PruneDeps {
  store: RunStore
  now?: () => number
}

export interface PruneOutcome {
  ok: true
  candidates: { id: string; workflowId: string; status: string; startedAt: number }[]
  deleted: string[]
  dryRun: boolean
}
export type PruneResult = PruneOutcome | { ok: false; message: string; exitCode: number }

export async function runWorkflowsPrune(args: ParsedArgs, deps: PruneDeps): Promise<PruneResult> {
  const olderThanFlag = getStringFlag(args, "older-than")
  const keep = getNumberFlag(args, "keep")
  const workflowId = getStringFlag(args, "workflow")
  const status = getStringFlag(args, "status")
  const dryRun = getBooleanFlag(args, "dry-run") === true

  if (olderThanFlag === undefined && keep === undefined) {
    return {
      ok: false,
      message:
        "voyant workflows prune: pass at least one of --older-than <duration> or --keep <N>. " +
        "Use --dry-run first to preview.",
      exitCode: 2,
    }
  }

  let olderThanMs: number | undefined
  if (olderThanFlag !== undefined) {
    const parsed = parseDuration(olderThanFlag)
    if (parsed === null) {
      return {
        ok: false,
        message: `voyant workflows prune: invalid --older-than "${olderThanFlag}" (expected e.g. 7d, 30m, 2h).`,
        exitCode: 2,
      }
    }
    olderThanMs = parsed
  }

  if (keep !== undefined && (!Number.isFinite(keep) || keep < 0)) {
    return {
      ok: false,
      message: `voyant workflows prune: --keep must be a non-negative integer (got ${keep}).`,
      exitCode: 2,
    }
  }

  if (!deps.store.delete) {
    return {
      ok: false,
      message: "voyant workflows prune: the run store does not support delete.",
      exitCode: 1,
    }
  }

  const now = (deps.now ?? (() => Date.now()))()
  const all = await deps.store.list({
    ...(workflowId ? { workflowId } : {}),
    ...(status ? { status } : {}),
  })

  // list() is already most-recent-first; `keep` slices from the tail.
  let candidates = all
  if (keep !== undefined) {
    candidates = candidates.slice(keep)
  }
  if (olderThanMs !== undefined) {
    const cutoff = now - olderThanMs
    candidates = candidates.filter((r) => r.startedAt <= cutoff)
  }

  const summarized = candidates.map(summaryOf)

  if (dryRun) {
    return { ok: true, candidates: summarized, deleted: [], dryRun: true }
  }

  const deleted: string[] = []
  for (const r of candidates) {
    const ok = await deps.store.delete(r.id)
    if (ok) deleted.push(r.id)
  }
  return { ok: true, candidates: summarized, deleted, dryRun: false }
}

function summaryOf(r: StoredRun): {
  id: string
  workflowId: string
  status: string
  startedAt: number
} {
  return {
    id: r.id,
    workflowId: r.workflowId,
    status: r.status,
    startedAt: r.startedAt,
  }
}

function parseDuration(s: string): number | null {
  const m = /^(\d+)(ms|s|m|h|d|w)$/.exec(s.trim())
  if (!m) return null
  const n = Number(m[1])
  switch (m[2]) {
    case "ms":
      return n
    case "s":
      return n * 1_000
    case "m":
      return n * 60_000
    case "h":
      return n * 3_600_000
    case "d":
      return n * 86_400_000
    case "w":
      return n * 604_800_000
    default:
      return null
  }
}

export async function defaultPruneDeps(): Promise<PruneDeps> {
  return { store: createFsRunStore() }
}
