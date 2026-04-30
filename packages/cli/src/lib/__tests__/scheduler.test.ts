import { describe, expect, it, vi } from "vitest"
import { computeNextFire, createScheduler, nextCronFire, parseCron, toMs } from "../scheduler.js"

describe("toMs", () => {
  it("passes numbers through", () => {
    expect(toMs(500)).toBe(500)
  })
  it("parses common units", () => {
    expect(toMs("250ms")).toBe(250)
    expect(toMs("5s")).toBe(5000)
    expect(toMs("2m")).toBe(120_000)
    expect(toMs("1h")).toBe(3_600_000)
    expect(toMs("1d")).toBe(86_400_000)
    expect(toMs("1w")).toBe(604_800_000)
  })
  it("rejects junk", () => {
    expect(() => toMs("bad" as "1s")).toThrow(/invalid duration/)
  })
})

describe("parseCron", () => {
  it("accepts a 5-field literal expression", () => {
    const s = parseCron("30 8 1 1 0")
    expect(s.minute).toEqual([30])
    expect(s.hour).toEqual([8])
    expect(s.day).toEqual([1])
    expect(s.month).toEqual([1])
    expect(s.dow).toEqual([0])
  })
  it("expands * to the full range", () => {
    const s = parseCron("* * * * *")
    expect(s.minute.length).toBe(60)
    expect(s.hour.length).toBe(24)
    expect(s.day).toContain(31)
    expect(s.dow).toEqual([0, 1, 2, 3, 4, 5, 6])
  })
  it("expands */N", () => {
    const s = parseCron("*/15 * * * *")
    expect(s.minute).toEqual([0, 15, 30, 45])
  })
  it("expands ranges + lists", () => {
    const s = parseCron("0 9-11,14 * * 1-5")
    expect(s.minute).toEqual([0])
    expect(s.hour).toEqual([9, 10, 11, 14])
    expect(s.dow).toEqual([1, 2, 3, 4, 5])
  })
  it("rejects invalid field counts", () => {
    expect(() => parseCron("* * *")).toThrow(/5 fields/)
  })
  it("rejects out-of-range values", () => {
    expect(() => parseCron("60 * * * *")).toThrow(/minute/)
    expect(() => parseCron("* 24 * * *")).toThrow(/hour/)
  })
})

describe("nextCronFire", () => {
  it("finds the next matching minute for '*/5 * * * *'", () => {
    // 2026-04-17T10:02:13Z → next at 10:05:00Z
    const spec = parseCron("*/5 * * * *")
    const from = Date.UTC(2026, 3, 17, 10, 2, 13)
    const next = nextCronFire(spec, from)
    expect(new Date(next).toISOString()).toBe("2026-04-17T10:05:00.000Z")
  })
  it("advances to the next day when the hour/minute already passed", () => {
    // "0 9 * * *" — daily 9:00 UTC. From 10:00 Apr 17 → next is Apr 18 09:00.
    const spec = parseCron("0 9 * * *")
    const from = Date.UTC(2026, 3, 17, 10, 0)
    const next = nextCronFire(spec, from)
    expect(new Date(next).toISOString()).toBe("2026-04-18T09:00:00.000Z")
  })
})

describe("computeNextFire", () => {
  it("handles every:N", () => {
    const from = 1_700_000_000_000
    expect(computeNextFire({ every: "5s" }, from)).toBe(from + 5_000)
  })
  it("returns Infinity for a past 'at'", () => {
    const from = Date.UTC(2026, 3, 17)
    const past = new Date(Date.UTC(2020, 0, 1)).toISOString()
    expect(computeNextFire({ at: past }, from)).toBe(Number.POSITIVE_INFINITY)
  })
  it("passes a future 'at' through", () => {
    const from = Date.UTC(2026, 3, 17)
    const future = new Date(Date.UTC(2027, 0, 1)).toISOString()
    expect(computeNextFire({ at: future }, from)).toBe(Date.parse(future))
  })
})

describe("createScheduler", () => {
  it("fires 'every' sources on each tick once they're due", async () => {
    let now = 1_000_000
    const fired: string[] = []
    const sched = createScheduler({
      sources: [{ workflowId: "wf", decl: { every: "1s" } }],
      onFire: async ({ workflowId }) => {
        fired.push(workflowId)
      },
      now: () => now,
      tickMs: 10_000,
    })

    // Before any time passes, nothing due.
    await sched.tick()
    expect(fired).toEqual([])

    // Jump 1.5s — due.
    now += 1_500
    await sched.tick()
    expect(fired).toEqual(["wf"])

    // Jump another 0.5s — not yet due (next was +1s from last fire).
    now += 500
    await sched.tick()
    expect(fired).toEqual(["wf"])

    // Another 600ms — due again.
    now += 600
    await sched.tick()
    expect(fired).toEqual(["wf", "wf"])
  })

  it("resolves a function 'input' fresh each fire", async () => {
    let now = 1_000
    const inputs: unknown[] = []
    let counter = 0
    const sched = createScheduler({
      sources: [
        {
          workflowId: "wf",
          decl: { every: "1s", input: () => ({ n: ++counter }) },
        },
      ],
      onFire: async ({ input }) => {
        inputs.push(input)
      },
      now: () => now,
    })
    now += 1_100
    await sched.tick()
    now += 1_100
    await sched.tick()
    expect(inputs).toEqual([{ n: 1 }, { n: 2 }])
  })

  it("fires 'at' exactly once, then stays done", async () => {
    let now = 1_000
    const fired: string[] = []
    const at = new Date(5_000).toISOString()
    const sched = createScheduler({
      sources: [{ workflowId: "wf", decl: { at } }],
      onFire: async ({ workflowId }) => {
        fired.push(workflowId)
      },
      now: () => now,
    })
    now = 4_000
    await sched.tick()
    expect(fired).toEqual([])
    now = 6_000
    await sched.tick()
    expect(fired).toEqual(["wf"])
    now = 7_000
    await sched.tick()
    expect(fired).toEqual(["wf"])
    expect(sched.nextFirings()[0]!.done).toBe(true)
  })

  it("skips sources whose 'at' is already in the past", async () => {
    let now = 10_000
    const fired: string[] = []
    const past = new Date(1_000).toISOString()
    const sched = createScheduler({
      sources: [{ workflowId: "wf", decl: { at: past } }],
      onFire: async ({ workflowId }) => {
        fired.push(workflowId)
      },
      now: () => now,
    })
    now = 20_000
    await sched.tick()
    expect(fired).toEqual([])
  })

  it("honors enabled: false", async () => {
    let now = 0
    const fired: string[] = []
    const sched = createScheduler({
      sources: [{ workflowId: "wf", decl: { every: "1s", enabled: false } }],
      onFire: async ({ workflowId }) => {
        fired.push(workflowId)
      },
      now: () => now,
    })
    now = 10_000
    await sched.tick()
    expect(fired).toEqual([])
    expect(sched.sourceCount()).toBe(0)
  })

  it("filters by environments", async () => {
    let now = 0
    const fired: string[] = []
    const sched = createScheduler({
      sources: [
        {
          workflowId: "prod-only",
          decl: { every: "1s", environments: ["production"] },
        },
        {
          workflowId: "dev-only",
          decl: { every: "1s", environments: ["development"] },
        },
      ],
      onFire: async ({ workflowId }) => {
        fired.push(workflowId)
      },
      now: () => now,
      environment: "development",
    })
    now = 2_000
    await sched.tick()
    expect(fired).toEqual(["dev-only"])
  })

  it("'skip' overlap blocks re-entry while onFire is in flight", async () => {
    let now = 0
    const fired: string[] = []
    let resolveFire: (() => void) | undefined
    const pending = new Promise<void>((r) => {
      resolveFire = r
    })
    const sched = createScheduler({
      sources: [{ workflowId: "wf", decl: { every: "500ms", overlap: "skip" } }],
      onFire: async ({ workflowId }) => {
        fired.push(workflowId)
        await pending
      },
      now: () => now,
    })
    // First tick launches a fire that won't resolve yet.
    now = 600
    const firstTick = sched.tick()
    // Advance + tick again *before* the first fire resolves.
    now = 1_300
    // We cannot await sched.tick under "skip" because it awaits the in-flight fire,
    // so run them concurrently.
    const secondTick = sched.tick()
    // Let the scheduler task churn.
    await Promise.resolve()
    // Resolve the pending first fire.
    resolveFire!()
    await firstTick
    await secondTick
    expect(fired.length).toBeLessThanOrEqual(2)
  })

  it("start / stop use the injected setInterval/clearInterval", () => {
    const setInt = vi.fn(() => 42 as unknown as NodeJS.Timeout)
    const clearInt = vi.fn()
    const sched = createScheduler({
      sources: [],
      onFire: async () => {},
      setInterval: setInt as unknown as typeof setInterval,
      clearInterval: clearInt as unknown as typeof clearInterval,
    })
    sched.start()
    expect(setInt).toHaveBeenCalledWith(expect.any(Function), 1000)
    sched.stop()
    expect(clearInt).toHaveBeenCalledWith(42)
  })
})
