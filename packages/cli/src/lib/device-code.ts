/**
 * RFC 8628 OAuth 2.0 Device Authorization Grant client for the Voyant CLI.
 *
 * The matching server endpoints live at `/cli/v1/device/{authorize,token}`
 * in voyant-cloud. The /token endpoint follows §3.5 (200+token, or 400+
 * `authorization_pending` / `slow_down` / `expired_token` / `access_denied`
 * / `invalid_grant`).
 */

export interface DeviceFlowClientInfo {
  hostname?: string
  platform?: string
  cliVersion?: string
}

export interface DeviceFlowCodes {
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresInSeconds: number
}

export interface DeviceFlowOptions {
  apiUrl: string
  /** Optional CLI metadata captured at /authorize for audit. */
  clientInfo?: DeviceFlowClientInfo
  /** Optional human label persisted with the device-code row. */
  name?: string
  /**
   * Called once after /authorize succeeds. Use this to print/browser-open
   * the verification URL — kept as a callback so the lib stays I/O-free.
   */
  onCodes?: (codes: DeviceFlowCodes) => void | Promise<void>
  /**
   * Override the polling interval (ms). Used by tests to keep them fast;
   * production callers omit this and let the server's `interval` rule.
   */
  pollIntervalMs?: number
  /** Inject a fetch impl in tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
  /** Cancel an in-flight flow (e.g. on Ctrl-C). */
  signal?: AbortSignal
}

export interface DeviceFlowResult {
  accessToken: string
  organizationId: string
  userId: string
}

export class DeviceFlowError extends Error {
  readonly code:
    | "expired_token"
    | "access_denied"
    | "invalid_grant"
    | "aborted"
    | "transport"
    | "unknown"
  constructor(code: DeviceFlowError["code"], message: string) {
    super(message)
    this.name = "DeviceFlowError"
    this.code = code
  }
}

interface AuthorizeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

interface TokenSuccessResponse {
  access_token: string
  token_type?: string
  organization_id: string
  user_id: string
}

interface TokenErrorResponse {
  error: string
}

/**
 * Run the full device-code dance against the Voyant Cloud /cli/v1/device
 * endpoints. Resolves with the minted token + identity on success.
 *
 * Polling cadence respects the server's `interval` field. The flow
 * abandons polling once the server-reported `expires_in` window has
 * elapsed (matching the row's `expires_at` on the server side).
 */
export async function runDeviceCodeFlow(opts: DeviceFlowOptions): Promise<DeviceFlowResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const baseUrl = opts.apiUrl.replace(/\/+$/, "")

  // Step 1: /authorize
  const authResp = await fetchImpl(`${baseUrl}/cli/v1/device/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: opts.signal,
    body: JSON.stringify({
      name: opts.name ?? null,
      client_info: opts.clientInfo ?? null,
    }),
  })

  if (!authResp.ok) {
    throw new DeviceFlowError(
      "transport",
      `Failed to start device flow: ${authResp.status} ${authResp.statusText}`,
    )
  }

  const codes = (await authResp.json()) as AuthorizeResponse

  if (opts.onCodes) {
    await opts.onCodes({
      userCode: codes.user_code,
      verificationUri: codes.verification_uri,
      verificationUriComplete: codes.verification_uri_complete,
      expiresInSeconds: codes.expires_in,
    })
  }

  // Step 2: poll /token. We trust the server's interval as the lower bound;
  // server-side rate limiting on /cli/* enforces a real floor.
  const intervalMs = opts.pollIntervalMs ?? Math.max(0, codes.interval * 1000)
  const deadline = Date.now() + codes.expires_in * 1000

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      throw new DeviceFlowError("aborted", "Login aborted")
    }

    await sleep(intervalMs, opts.signal)

    const pollResp = await fetchImpl(`${baseUrl}/cli/v1/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: opts.signal,
      body: JSON.stringify({ device_code: codes.device_code }),
    })

    if (pollResp.ok) {
      const data = (await pollResp.json()) as TokenSuccessResponse
      return {
        accessToken: data.access_token,
        organizationId: data.organization_id,
        userId: data.user_id,
      }
    }

    // 400 with RFC 8628 error code in body.
    const body = await readJsonSafe<TokenErrorResponse>(pollResp)
    const err = body?.error

    if (err === "authorization_pending" || err === "slow_down") continue

    if (err === "expired_token") {
      throw new DeviceFlowError("expired_token", "Login window expired. Re-run `voyant login`.")
    }

    if (err === "access_denied") {
      throw new DeviceFlowError("access_denied", "Login was denied in the browser.")
    }

    if (err === "invalid_grant") {
      throw new DeviceFlowError(
        "invalid_grant",
        "Device code is no longer valid. Re-run `voyant login`.",
      )
    }

    throw new DeviceFlowError(
      "unknown",
      `Login failed: ${err ?? `${pollResp.status} ${pollResp.statusText}`}`,
    )
  }

  throw new DeviceFlowError("expired_token", "Login timed out. Re-run `voyant login`.")
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DeviceFlowError("aborted", "Login aborted"))
      return
    }
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DeviceFlowError("aborted", "Login aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

async function readJsonSafe<T>(resp: Response): Promise<T | null> {
  try {
    return (await resp.json()) as T
  } catch {
    return null
  }
}
