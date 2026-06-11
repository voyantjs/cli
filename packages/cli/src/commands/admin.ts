import { parseArgs } from "../lib/args.js"
import type { CommandContext, CommandResult } from "../types.js"
import { adminDoctorCommand } from "./admin-doctor.js"
import { adminGenerateCommand } from "./admin-generate.js"

/**
 * `voyant admin <subcommand>` — manifest-driven admin composition tooling
 * (packaged-admin RFC §4.1).
 *
 * - `generate` — emit the committed `admin.extensions.generated.ts` from
 *   voyant.config.* (see {@link adminGenerateCommand}).
 * - `doctor` — report-only parity check between manifest, generated
 *   composition, and host route files (see {@link adminDoctorCommand}).
 */
export async function adminCommand(ctx: CommandContext): Promise<CommandResult> {
  const { positionals } = parseArgs(ctx.argv)
  const sub = positionals[0]
  if (!sub) {
    ctx.stderr("Usage: voyant admin <generate|doctor> [...args]\n")
    return 1
  }

  const idx = ctx.argv.indexOf(sub)
  const subArgs = idx >= 0 ? ctx.argv.slice(idx + 1) : []

  if (sub === "generate") {
    return adminGenerateCommand({ ...ctx, argv: subArgs })
  }
  if (sub === "doctor") {
    return adminDoctorCommand({ ...ctx, argv: subArgs })
  }

  ctx.stderr(`Unknown admin subcommand: ${sub}. Expected "generate" or "doctor".\n`)
  return 1
}
