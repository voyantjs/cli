// File-based run store. One JSON file per run under `.voyant/runs/`.
// Used by `voyant workflows run` (save), `voyant workflows runs`
// (list), and `voyant workflows run-detail` (get).
//
// Tenant-agnostic, single-machine, zero-dep. In production the
// dashboard reads from the control-plane REST API instead.

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

export interface StoredRun {
  id: string
  workflowId: string
  status: string
  startedAt: number
  completedAt?: number
  durationMs?: number
  tags?: string[]
  /** Full TestResult-shaped payload. */
  result: Record<string, unknown>
  /** Input passed to the workflow. */
  input: unknown
  /** Absolute path to the compiled entry file used when the run was triggered. Lets `replay` re-load without specifying --file again. */
  entryFile?: string
  /** When set, the id of the run this one was replayed from. */
  replayOf?: string
}

export interface ListFilter {
  workflowId?: string
  status?: string
  limit?: number
}

export interface RunStore {
  save(args: {
    workflowId: string
    input: unknown
    result: Record<string, unknown>
    entryFile?: string
    replayOf?: string
  }): Promise<StoredRun>
  list(filter?: ListFilter): Promise<StoredRun[]>
  get(runId: string): Promise<StoredRun | undefined>
  /**
   * Overwrite an existing stored run in place. Used by the resume path:
   * a parked run is persisted with status="waiting", then the same id
   * is rewritten once an event / signal / token injection unblocks it.
   */
  update?(run: StoredRun): Promise<StoredRun>
  /**
   * Delete a single stored run. Returns `true` if it was removed,
   * `false` if the id didn't exist. Used by the `prune` command.
   */
  delete?(runId: string): Promise<boolean>
}

export interface FsStoreOptions {
  /** Root directory (`.voyant/runs/` under cwd by default). */
  rootDir?: string
  /** Clock source — injectable for tests. */
  now?: () => number
  /** Random source — injectable for tests. */
  random?: () => number
}

export function createFsRunStore(opts: FsStoreOptions = {}): RunStore {
  const rootDir = opts.rootDir ?? resolve(process.cwd(), ".voyant", "runs")
  const now = opts.now ?? (() => Date.now())
  const random = opts.random ?? Math.random

  return {
    async save({ workflowId, input, result, entryFile, replayOf }) {
      const startedAt = toNumber(result.startedAt) ?? now()
      const completedAt = toNumber(result.completedAt)
      const stored: StoredRun = {
        id: generateRunId(now, random),
        workflowId,
        status: typeof result.status === "string" ? result.status : "unknown",
        startedAt,
        completedAt,
        durationMs: completedAt !== undefined ? completedAt - startedAt : undefined,
        tags: Array.isArray(result.tags) ? (result.tags as string[]) : undefined,
        result,
        input,
        entryFile,
        replayOf,
      }

      await mkdir(join(rootDir, stored.id), { recursive: true })
      await writeFile(join(rootDir, stored.id, "run.json"), JSON.stringify(stored, null, 2))
      return stored
    },

    async list(filter = {}) {
      const entries = await safeReaddir(rootDir)
      const runs: StoredRun[] = []
      for (const entry of entries) {
        const run = await readRunFile(join(rootDir, entry, "run.json"))
        if (!run) continue
        if (filter.workflowId && run.workflowId !== filter.workflowId) continue
        if (filter.status && run.status !== filter.status) continue
        runs.push(run)
      }
      // Most recent first.
      runs.sort((a, b) => b.startedAt - a.startedAt)
      if (filter.limit !== undefined) return runs.slice(0, filter.limit)
      return runs
    },

    async get(runId) {
      return (await readRunFile(join(rootDir, runId, "run.json"))) ?? undefined
    },

    async update(run) {
      await mkdir(join(rootDir, run.id), { recursive: true })
      await writeFile(join(rootDir, run.id, "run.json"), JSON.stringify(run, null, 2))
      return run
    },

    async delete(runId) {
      try {
        await rm(join(rootDir, runId), { recursive: true, force: false })
        return true
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === "ENOENT") return false
        throw err
      }
    },
  }
}

// ---- Helpers ----

function toNumber(x: unknown): number | undefined {
  return typeof x === "number" ? x : undefined
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    // Filter to directories only. Avoid false positives from stray files.
    const result: string[] = []
    for (const e of entries) {
      try {
        const s = await stat(join(dir, e))
        if (s.isDirectory()) result.push(e)
      } catch {
        // Ignore read errors per-entry.
      }
    }
    return result
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return []
    throw err
  }
}

async function readRunFile(path: string): Promise<StoredRun | null> {
  try {
    const text = await readFile(path, "utf8")
    return JSON.parse(text) as StoredRun
  } catch {
    return null
  }
}

function generateRunId(now: () => number, random: () => number): string {
  // Short, sortable-ish id. Uses a base-36 timestamp prefix + random suffix.
  // Not cryptographic; for local-dev uniqueness only.
  const ts = now().toString(36)
  const rand = Math.floor(random() * 1_000_000)
    .toString(36)
    .padStart(4, "0")
  return `run_${ts}_${rand}`
}
