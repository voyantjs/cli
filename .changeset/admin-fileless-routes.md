---
"@voyantjs/cli": minor
---

`voyant admin generate --routes` now emits the CODE-ASSEMBLED admin route module (packaged-admin RFC §4.8 — voyantjs/voyant#1643): one committed `src/admin.routes.generated.tsx` holding a code-based `createRoute` per implemented extension route contribution (`page` or `component` — `$param` routes included), options resolved from the host-registered extension instances via `adminExtensionRouteOptions`, literal paths + typed search contracts (search schemas resolved statically and imported from the admin entry), and the three `AdminExtensionRoutesBy*` typed-link map interfaces the host's `router.tsx` merges. NO per-route files exist for package-delivered pages.

- The ejection-header contract carries over: a target module without the generated header is never overwritten; a hand-written route file binding a contribution's path ejects that single route from the module; leftover generated thin route files (increment 1) are deleted on write and flagged as drift with `--check`.
- The static scanner now recognizes lazy `page:` loaders (in addition to `component:`) when deciding a contribution is implemented, and key-matches properties preceded by doc comments.
- The legacy per-route thin-file emission remains available behind `voyant admin generate --routes --files` for hosts not yet migrated (the voyant monorepo no longer uses it).
- `admin doctor` Finding C (route parity) accepts EITHER a route file under the routes dir OR an entry in the code-assembled module (default `src/admin.routes.generated.tsx`; `--routes-dir`/`--routes-out` flags and `admin.routes.dir`/`admin.routes.out` manifest keys are honored) — this removes the false positive on package-delivered fileless routes like `/promotions`. Declared paths now come from resolved route contributions instead of a raw `path:`-literal regex. Still report-only.
- Manifest `admin.routes` gains `out`, `registryModule`, `registryExport`, and `workspaceRouteModule` knobs; defaults follow the operator conventions (`@/lib/admin-extensions`, `@/routes/_workspace/route`).
- Includes the `<module>-react/admin` entry convention fix (the `*-ui` packages merged into `*-react`, voyantjs/voyant#1652/#1670).

Emission fidelity is validated against the real operator template: `voyant admin generate --routes --check` reports its checked-in `admin.routes.generated.tsx` (49 routes across 10 extensions) byte-for-byte up to date, and `voyant admin doctor` reports 0 findings.
