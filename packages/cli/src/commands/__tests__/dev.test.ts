import { describe, expect, it, vi } from "vitest"
import { runDev } from "../dev.js"
import type { ServeHandle, ServeOptions } from "../workflows/serve.js"

const OPTIONS: ServeOptions = { port: 3232, host: "127.0.0.1" }

function makeServeHandle(
  overrides: Partial<ServeHandle> = {},
): ServeHandle & { workflowCount?: number; scheduleCount?: number } {
  return {
    url: `http://${OPTIONS.host}:${OPTIONS.port}`,
    close: async () => {},
    ...overrides,
  }
}

describe("runDev", () => {
  /**
   * Matches the real bundler contract: `startBundler` must fire
   * `onRebuild` at least once (the initial build) before resolving,
   * so `runDev` can return a ready handle. The stored `savedOnRebuild`
   * reference lets tests fire additional rebuilds mid-test.
   */
  function autoFiringBundler(): {
    startBundler: (args: {
      entryFile: string
      outFile: string
      onRebuild: (o: { ok: boolean; errors: string[] }) => Promise<void>
    }) => Promise<{ dispose: () => Promise<void> }>
    disposeSpy: ReturnType<typeof vi.fn>
    onRebuild: () => (o: { ok: boolean; errors: string[] }) => Promise<void>
  } {
    let saved: ((o: { ok: boolean; errors: string[] }) => Promise<void>) | undefined
    const disposeSpy = vi.fn(async () => {})
    return {
      onRebuild: () => saved!,
      disposeSpy,
      startBundler: async ({ onRebuild }) => {
        saved = onRebuild
        // Simulate the initial build completing.
        await onRebuild({ ok: true, errors: [] })
        return { dispose: disposeSpy }
      },
    }
  }

  it("starts the bundler + serve and resolves to a handle", async () => {
    const startServe = vi.fn(async () =>
      makeServeHandle({ workflowCount: 2 } as ServeHandle & { workflowCount: number }),
    )
    const bundler = autoFiringBundler()
    const handle = await runDev(
      { entryFile: "src/app.ts", outDir: ".voyant/dev", options: OPTIONS },
      { startBundler: bundler.startBundler, startServe, log: () => {} },
    )
    expect(handle.url).toBe("http://127.0.0.1:3232")
    expect(startServe).toHaveBeenCalledTimes(1) // initial build fired onRebuild once
    await handle.close()
  })

  it("reloads the serve when the bundler reports a successful rebuild", async () => {
    const bundler = autoFiringBundler()
    const closeSpy = vi.fn(async () => {})
    const startServe = vi.fn(async () => makeServeHandle({ close: closeSpy, workflowCount: 1 }))
    const handle = await runDev(
      { entryFile: "src/app.ts", outDir: ".voyant/dev", options: OPTIONS },
      { startBundler: bundler.startBundler, startServe, log: () => {} },
    )

    expect(startServe).toHaveBeenCalledTimes(1)
    await bundler.onRebuild()({ ok: true, errors: [] })
    expect(startServe).toHaveBeenCalledTimes(2)
    expect(closeSpy).toHaveBeenCalledTimes(1)
    await handle.close()
  })

  it("does NOT reload on a failed rebuild (keeps the old serve up)", async () => {
    const bundler = autoFiringBundler()
    const startServe = vi.fn(async () => makeServeHandle())
    const logs: { level: string; msg: string }[] = []
    const handle = await runDev(
      { entryFile: "src/app.ts", outDir: ".voyant/dev", options: OPTIONS },
      {
        startBundler: bundler.startBundler,
        startServe,
        log: (level, msg) => {
          logs.push({ level, msg })
        },
      },
    )
    await bundler.onRebuild()({ ok: false, errors: ["syntax error on line 3"] })
    expect(startServe).toHaveBeenCalledTimes(1) // no extra serve start
    expect(logs.some((l) => l.level === "error" && /syntax error/.test(l.msg))).toBe(true)
    await handle.close()
  })

  it("close() disposes the bundler and the current serve", async () => {
    const bundler = autoFiringBundler()
    const serveClose = vi.fn(async () => {})
    const handle = await runDev(
      { entryFile: "src/app.ts", outDir: ".voyant/dev", options: OPTIONS },
      {
        startBundler: bundler.startBundler,
        startServe: async () => makeServeHandle({ close: serveClose }),
        log: () => {},
      },
    )
    await handle.close()
    expect(bundler.disposeSpy).toHaveBeenCalledTimes(1)
    expect(serveClose).toHaveBeenCalledTimes(1)
  })

  it("ignores rebuilds that arrive after close()", async () => {
    const bundler = autoFiringBundler()
    const startServe = vi.fn(async () => makeServeHandle())
    const handle = await runDev(
      { entryFile: "src/app.ts", outDir: ".voyant/dev", options: OPTIONS },
      { startBundler: bundler.startBundler, startServe, log: () => {} },
    )
    await handle.close()
    startServe.mockClear()
    await bundler.onRebuild()({ ok: true, errors: [] })
    expect(startServe).not.toHaveBeenCalled()
  })

  it("serializes rebuilds so two fast-fire successes don't race", async () => {
    const bundler = autoFiringBundler()
    const starts: number[] = []
    const closes: number[] = []
    let t = 0
    const startServe = vi.fn(async () => {
      const mine = ++t
      starts.push(mine)
      return makeServeHandle({
        close: async () => {
          closes.push(mine)
        },
      })
    })
    const handle = await runDev(
      { entryFile: "src/app.ts", outDir: ".voyant/dev", options: OPTIONS },
      { startBundler: bundler.startBundler, startServe, log: () => {} },
    )
    // Fire two more rebuilds without awaiting the first.
    const fireRebuild = bundler.onRebuild()
    const a = fireRebuild({ ok: true, errors: [] })
    const b = fireRebuild({ ok: true, errors: [] })
    await Promise.all([a, b])
    // 1 initial + 2 rebuilds = 3 serves, each preceded by a close of the prior.
    expect(starts.length).toBe(3)
    expect(closes.length).toBe(2)
    await handle.close()
  })
})
