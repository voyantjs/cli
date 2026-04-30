# @voyantjs/cli

## 0.20.0

### Minor Changes

- 07085fb: First release of `@voyantjs/cli` from the dedicated `voyantjs/cli` repo —
  published as `0.20.0` (the `0.19.0` version was already shipped from
  `voyantjs/voyant` before that repo's `packages/cli` was privatized; from
  this point on, all `@voyantjs/cli` releases come from `voyantjs/cli`).

  This is the unified CLI for the Voyant open-source framework AND the Voyant
  Cloud platform — replacing the in-monorepo `@voyantjs/cli@0.18.x`/`0.19.0`
  that previously shipped from `voyantjs/voyant`.

  **Open source (no login required):**

  Ports every command from the previous in-monorepo CLI 1:1 — `new`,
  `generate {module,link}`, `config`, `db {generate,migrate,studio,push,check,sync-links,schemas}`,
  `exec`, `dev`, `workflows`. Same commands, same flags, same tests.

  Two monorepo-coupling issues from the previous version are fixed:

  - `voyant new` no longer assumes a sibling `templates/` directory in a
    Voyant checkout. Built-in starters now resolve from the
    `github.com/voyantjs/voyant` releases tarballs.
  - `voyant db` no longer hardcodes `templates/dmc` — it resolves the
    drizzle config from `cwd` (or `--template <path>`).

  **Cloud (Voyant Cloud login):**

  - `voyant login` — browser device-code flow (RFC 8628), or
    `--token <value>` for CI/headless. Tokens stored in
    `~/.voyant/credentials.json` keyed by API URL.
  - `voyant logout`, `voyant whoami`.
  - `voyant vaults list`.
  - `voyant secrets list/get/set/rm`.

  **Decoupled framework version.** The CLI's own version is now independent
  of the framework version it scaffolds projects against — bumping the CLI
  no longer drags `@voyantjs/core` deps in `voyant new` / `voyant generate
module` output.
