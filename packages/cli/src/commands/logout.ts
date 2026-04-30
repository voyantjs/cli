import { getStringFlag, parseArgs } from "../lib/args.js"
import { DEFAULT_CLOUD_API_URL } from "../lib/cloud-client.js"
import { clearCredential, getCredential } from "../lib/credentials.js"
import type { CommandContext, CommandResult } from "../types.js"

/**
 * `voyant logout [--api-url <url>]`
 *
 * Removes the stored credential for the resolved API URL. Does NOT call the
 * server — `logout` always succeeds offline. Token revocation lives in the
 * dashboard tokens UI.
 */
export function logoutCommand(ctx: CommandContext): CommandResult {
  const args = parseArgs(ctx.argv)
  const apiUrl =
    getStringFlag(args, "api-url") || process.env.VOYANT_CLOUD_API_URL || DEFAULT_CLOUD_API_URL

  if (!getCredential(apiUrl)) {
    ctx.stdout(`Not logged in to ${apiUrl}.\n`)
    return 0
  }

  clearCredential(apiUrl)
  ctx.stdout(`Logged out of ${apiUrl}.\n`)
  return 0
}
