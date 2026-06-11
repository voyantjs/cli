---
"@voyantjs/cli": minor
---

New `voyant admin` commands — manifest-driven admin composition for the
packaged-admin RFC (voyant#1643 Phase 2):

- `voyant admin generate [--config <path>] [--out <file>] [--check]` — scans
  the manifest's modules, resolves each module's admin entry via the
  `<module>-ui/admin` convention (or an explicit `package.json#voyant.adminEntry`
  override) by pure package.json `exports` inspection, and emits a committed
  `src/admin.extensions.generated.ts` with static factory imports. `--check`
  exits 1 on drift for CI.
- `voyant admin doctor [--config <path>] [--out <file>]` — report-only parity
  check: admin entries not imported in the generated file, generated imports
  whose module left the manifest, and extension route paths with no matching
  host route file.
