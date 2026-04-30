import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/** Write `content` to `path`, creating parent directories as needed. */
export function writeTextFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, { encoding: "utf8" })
}

/** Return true if `path` exists on disk. */
export function pathExists(path: string): boolean {
  return existsSync(path)
}
