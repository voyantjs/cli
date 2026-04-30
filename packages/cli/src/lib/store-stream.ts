// Store-change subscription. Polls a RunStore at a fixed cadence and
// emits `snapshot` / `added` / `updated` / `removed` events to every
// connected subscriber. Used by the SSE endpoint on `voyant workflows
// serve` to push updates to the dashboard without WebSocket.
//
// Polling keeps the implementation simple, cross-platform, and easy to
// test — no fs.watch edge cases. A production orchestrator would push
// directly from the Run DO (§7.5.2 of docs/design.md).

import type { RunStore, StoredRun } from "./run-store.js"

export type StoreEvent =
  | { kind: "snapshot"; runs: readonly StoredRun[] }
  | { kind: "added"; run: StoredRun }
  | { kind: "updated"; run: StoredRun }
  | { kind: "removed"; runId: string }

export type StoreListener = (event: StoreEvent) => void

export interface StoreStream {
  subscribe: (listener: StoreListener) => () => void
  /** Force a poll now. Useful in tests; noop if already in flight. */
  poll: () => Promise<void>
  /** Stop the background poll loop. */
  stop: () => void
  /** Current number of active subscribers. */
  subscriberCount: () => number
}

export interface StoreStreamOptions {
  /** Polling interval in ms. Default 1000. */
  intervalMs?: number
  /** Injectable timer (for tests). */
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
}

/**
 * Pure diff over two snapshots keyed by run id. `updated` fires when
 * the status or durationMs changes — those are the fields most likely
 * to flip during a live run.
 */
export function diffSnapshots(
  prev: readonly StoredRun[],
  next: readonly StoredRun[],
): StoreEvent[] {
  const prevById = new Map(prev.map((r) => [r.id, r]))
  const nextById = new Map(next.map((r) => [r.id, r]))
  const events: StoreEvent[] = []

  for (const n of next) {
    const p = prevById.get(n.id)
    if (!p) {
      events.push({ kind: "added", run: n })
      continue
    }
    if (p.status !== n.status || p.durationMs !== n.durationMs) {
      events.push({ kind: "updated", run: n })
    }
  }

  for (const p of prev) {
    if (!nextById.has(p.id)) {
      events.push({ kind: "removed", runId: p.id })
    }
  }

  return events
}

export function createStoreStream(store: RunStore, opts: StoreStreamOptions = {}): StoreStream {
  const intervalMs = opts.intervalMs ?? 1000
  const setIntervalImpl = opts.setInterval ?? setInterval
  const clearIntervalImpl = opts.clearInterval ?? clearInterval

  const listeners = new Set<StoreListener>()
  let current: StoredRun[] = []
  let polling = false
  let initialised = false

  async function pollOnce(): Promise<void> {
    if (polling) return
    polling = true
    try {
      const next = await store.list()
      if (!initialised) {
        current = next
        initialised = true
        return
      }
      const events = diffSnapshots(current, next)
      current = next
      if (events.length === 0) return
      for (const ev of events) {
        for (const l of listeners) l(ev)
      }
    } catch {
      // Swallow — polling never crashes the server. A production
      // orchestrator would surface this as an operational alert.
    } finally {
      polling = false
    }
  }

  const handle = setIntervalImpl(() => {
    void pollOnce()
  }, intervalMs)
  // Node timers keep the event loop alive unless unref'd. Harmless in
  // browsers where `unref` is absent.
  ;(handle as unknown as { unref?: () => void }).unref?.()

  return {
    subscribe(listener) {
      // Emit a snapshot immediately so the client can paint without
      // waiting for the next poll. Use the cached list if we have one;
      // otherwise trigger a blocking poll + snapshot.
      const dispatchSnapshot = async (): Promise<void> => {
        if (!initialised) {
          current = await store.list()
          initialised = true
        }
        listener({ kind: "snapshot", runs: current })
      }
      void dispatchSnapshot()
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    poll: pollOnce,
    stop() {
      clearIntervalImpl(handle)
      listeners.clear()
    },
    subscriberCount() {
      return listeners.size
    },
  }
}
