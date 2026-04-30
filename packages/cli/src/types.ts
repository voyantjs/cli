export interface CommandContext {
  /** Command-specific argv (already trimmed of parent subcommands). */
  argv: ReadonlyArray<string>
  /** Working directory the command should use for relative paths. */
  cwd: string
  /** Write to stdout. Never appends a trailing newline. */
  stdout: (chunk: string) => void
  /** Write to stderr. Never appends a trailing newline. */
  stderr: (chunk: string) => void
}

/** Exit code. `undefined` means the command is long-lived and keeps the process alive. */
export type CommandResult = number | undefined
