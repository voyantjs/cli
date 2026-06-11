---
"@voyantjs/cli": patch
---

Drop the retired `dmc` starter: `voyant new` now defaults to the `operator` template (the only starter shipped by the voyant monorepo since voyantjs/voyant#1643 Phase 3). Unknown template names, including `dmc`, still fail with an explicit "Could not find a template" error.
