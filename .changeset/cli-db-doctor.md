---
"@voyantjs/cli": minor
---

Add migration-resilience `voyant db` tooling:

- `voyant db doctor` — report-first migration drift check (manifest resolvability, schema parity, generated-manifest freshness, duplicate-prefix baseline, link-tables-in-snapshot) with `--fail-on-drift` to gate CI.
- Manifest-driven schema resolution: `resolveSchemas` seeds from `modules` + `extensions` + `additionalSchemas`; `db schemas --emit` and `db generate` write a committed `drizzle.schemas.generated.ts`.
- `db sync-links --emit-drizzle` generates Drizzle table definitions for cross-module link tables so they fold into the migration snapshot.
- `db generate` forwards flags to drizzle-kit and defaults to `--prefix timestamp` for collision-free migration ordering.
