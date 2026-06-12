---
"@voyantjs/cli": minor
---

`voyant admin generate --destinations` + doctor Finding D gate (packaged-admin RFC §4.7 endgame).

- `voyant admin generate --destinations [--out <file>] [--check]` emits the
  generated destination resolver map (`src/admin.destinations.generated.ts`):
  one pure path-interpolation resolver (`encodeURIComponent`,
  `destinationParams` name mapping) per route contribution annotated with
  `destination:`, `satisfies Partial<AdminDestinationResolvers>`. Generated
  header + ejection contract (a file without the header is never touched; a
  stale generated file converges to deletion when no annotations remain) and
  a `--check` drift gate, same as `--routes`.
- `voyant admin doctor` Finding D is now two-tier: the GENERATED portion
  gates (exit 1) — an annotated destination missing from the generated
  module, a generated resolver whose annotation vanished, or any content
  drift; an ejected module skips the gate but keeps its keys for parity.
  Custom-resolver parity against declared `AdminDestinations` keys stays
  report-only (exit 0). New `--destinations-out <file>` flag for
  non-default generated-module paths.
- Contribution scanning learns the `destination:` string literal and the
  `destinationParams: { route: "destination" }` object literal.
