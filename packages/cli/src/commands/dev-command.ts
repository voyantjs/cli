import { parseArgs } from "../lib/args.js"
import type { CommandContext, CommandResult } from "../types.js"
import { defaultDevDeps, parseServeOptions, runDev } from "./dev.js"

export async function devCommand(ctx: CommandContext): Promise<CommandResult> {
  const args = parseArgs(ctx.argv)
  const parsed = parseServeOptions(args)
  if (!parsed.ok) {
    ctx.stderr(`${parsed.message}\n`)
    return parsed.exitCode
  }

  const entryFile = typeof args.flags.file === "string" ? args.flags.file : undefined
  if (!entryFile) {
    ctx.stderr("voyant dev: missing required --file <path>\n")
    return 2
  }

  const outDir = typeof args.flags.out === "string" ? args.flags.out : ".voyant/dev"

  let handle: { close: () => Promise<void>; url: string } | undefined
  try {
    handle = await runDev({ entryFile, outDir, options: parsed.options }, await defaultDevDeps())
  } catch (err) {
    ctx.stderr(`voyant dev: failed to start: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  ctx.stderr(`voyant dev: listening at ${handle.url}\n`)
  ctx.stderr(`  watching ${entryFile}\n`)
  ctx.stderr(`  output   ${outDir}\n`)
  ctx.stderr("Press Ctrl+C to stop.\n")

  const shutdown = async (): Promise<void> => {
    if (handle) await handle.close()
    process.exit(0)
  }
  process.once("SIGINT", () => {
    void shutdown()
  })
  process.once("SIGTERM", () => {
    void shutdown()
  })

  return undefined
}
