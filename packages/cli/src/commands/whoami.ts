import { getStringFlag, parseArgs } from "../lib/args.js"
import { CloudAuthError, resolveCloudAuth } from "../lib/cloud-client.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * `voyant whoami [--api-url <url>] [--token <tok>]`
 *
 * Prints the resolved auth source and API URL. Today this is local-only —
 * a future cut will also fetch a server-side `/whoami` once the matching
 * voyant-cloud endpoint lands, surfacing the organization and user behind
 * the token.
 */
export function whoamiCommand(ctx: CommandContext): CommandResult {
  const args = parseArgs(ctx.argv)
  try {
    const auth = resolveCloudAuth({
      token: getStringFlag(args, "token"),
      apiUrl: getStringFlag(args, "api-url"),
    })
    ctx.stdout(`API URL:      ${auth.apiUrl}\n`)
    ctx.stdout(`Token source: ${auth.source}\n`)
    return 0
  } catch (err) {
    if (err instanceof CloudAuthError) {
      ctx.stderr(`${err.message}\n`)
      return 1
    }
    throw err
  }
}
