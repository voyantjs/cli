---
"@voyantjs/cli": minor
---

`admin generate --routes` + `admin doctor`: core extension, nested children, and redirect contributions (packaged-admin RFC voyantjs/voyant#1643 final sweep)

- Scanner: extracts `redirectTo` (template-literal-resolved like `path`); redirect-only contributions count as implemented. Descends into `children: [...]` arrays (parent-relative paths, `"/"` = index) producing parent/child structures; spread elements (runtime-known children) stay invisible by design.
- `admin generate --routes` includes the BUILT-IN core entry `@voyantjs/admin-app/core-extension` (extension id `core`, factory `createAdminCoreExtension`) independently of the manifest module list — conditional on the package resolving from the host with a `"./core-extension"` export, so pre-core hosts are unaffected. The core factory builds its routes imperatively (unscannable), so the CLI carries its static contribution table (dashboard `/`, account, settings layout + index redirect + 9 built-in pages).
- Nested emission: layout parents emit an accessor thunk (`const coreSettings = () => CoreSettingsRoute`), children with `getParentRoute`, and a `<Parent>RouteWithChildren = parent.addChildren([...static, ...adminExtensionChildRoutes(ext, id, accessor, runtime, { exclude: [...] })])` subtree; the tree array references the `WithChildren` const.
- Typed-link maps handle nested/index/redirect shapes: parent → `typeof <Parent>RouteWithChildren` (ByFullPath/ById), index child claims `"<parent>/"` (ByFullPath), `"<parent>"` (ByTo), and `"/_workspace<parent>/"` (ById); redirect leaves keep plain keys.
- Doctor Finding C: redirect contributions bound in the generated module satisfy their path with no file and no page; children are traversed with absolute paths reconstructed on both sides (contributions AND the generated module's nested `createRoute` trees); runtime-bound extraPages children never report; the core entry participates when resolvable.
- `--routes --files` (legacy thin files) skips redirect/children contributions — they are module-only concepts — and never emits the core entry.
- The workspace layout's own `route.tsx` no longer ejects the root path `/` (it is the layout, not the index binding).
