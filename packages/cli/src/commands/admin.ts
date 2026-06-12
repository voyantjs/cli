import { parseArgs } from "../lib/args.js"
import type { CommandContext, CommandResult } from "../types.js"
import { adminDoctorCommand } from "./admin-doctor.js"
import { adminGenerateCommand } from "./admin-generate.js"

/**
 * `voyant admin <subcommand>` — manifest-driven admin composition tooling
 * (packaged-admin RFC §4.1).
 *
 * - `generate` — emit the committed `admin.extensions.generated.ts` from
 *   voyant.config.*; with `--routes`, emit the code-assembled admin route
 *   module (packaged-admin RFC §4.8; `--routes --files` keeps the legacy
 *   per-route thin files); with `--destinations`, emit the generated
 *   destination resolver map from the contributions' `destination:`
 *   annotations (RFC §4.7 endgame) — see {@link adminGenerateCommand}.
 * - `doctor` — parity check between manifest, generated composition, host
 *   routes (files or the code-assembled module), and the destination
 *   resolver maps. Findings A–C and custom-resolver parity stay report-only;
 *   the GENERATED destination map is a gate — annotation/emission drift
 *   exits 1 (see {@link adminDoctorCommand}).
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
