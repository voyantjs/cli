import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * One stored credential entry, keyed by API URL inside a {@link CredentialsFile}.
 *
 * `organizationId` / `userId` are optional because some auth flows (raw API
 * tokens) don't surface them; the device-code flow will fill them in.
 */
export interface Credential {
  accessToken: string
  organizationId?: string
  userId?: string
  /** ISO 8601 timestamp of when this credential was stored. */
  createdAt: string
}

/**
 * Map of `apiUrl → Credential`. Multiple environments (prod / staging / a
 * self-hosted Voyant Cloud) can coexist in one file.
 */
export type CredentialsFile = Record<string, Credential>

const ENV_OVERRIDE = "VOYANT_CREDENTIALS_FILE"

/**
 * Default location of the credentials file. Honors `VOYANT_CREDENTIALS_FILE`
 * for tests and for users who keep dotfiles elsewhere.
 */
export function getCredentialsPath(): string {
  const override = process.env[ENV_OVERRIDE]
  if (override && override.length > 0) return override
  return join(homedir(), ".voyant", "credentials.json")
}

/**
 * Read and parse the credentials file. Missing or unparseable files are
 * treated as empty — the CLI never crashes because someone hand-edited it.
 */
export function loadCredentials(path: string = getCredentialsPath()): CredentialsFile {
  if (!existsSync(path)) return {}
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return {}
  }
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as CredentialsFile
  } catch {
    return {}
  }
}

/**
 * Write the credentials file with mode 0600. Creates the parent directory
 * with mode 0700 if it doesn't exist. Mode-setting is a no-op on Windows.
 */
export function saveCredentials(file: CredentialsFile, path: string = getCredentialsPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  // writeFileSync only sets mode on file creation, so re-chmod for the
  // overwrite case to make sure we never leak a previously-loose mode.
  if (process.platform !== "win32") chmodSync(path, 0o600)
}

export function getCredential(
  apiUrl: string,
  path: string = getCredentialsPath(),
): Credential | undefined {
  return loadCredentials(path)[normalizeApiUrl(apiUrl)]
}

export function setCredential(
  apiUrl: string,
  cred: Credential,
  path: string = getCredentialsPath(),
): void {
  const file = loadCredentials(path)
  file[normalizeApiUrl(apiUrl)] = cred
  saveCredentials(file, path)
}

/**
 * Remove the credential for `apiUrl`. If that was the only entry, deletes
 * the file entirely instead of leaving an empty `{}` stub on disk.
 */
export function clearCredential(apiUrl: string, path: string = getCredentialsPath()): void {
  const file = loadCredentials(path)
  delete file[normalizeApiUrl(apiUrl)]
  if (Object.keys(file).length === 0) {
    if (existsSync(path)) unlinkSync(path)
    return
  }
  saveCredentials(file, path)
}

function normalizeApiUrl(url: string): string {
  return url.replace(/\/+$/, "")
}
