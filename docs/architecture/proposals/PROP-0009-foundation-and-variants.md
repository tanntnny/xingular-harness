---
id: PROP-0009
title: Name the fixed half the foundation and the mutating half the variant
status: Accepted
created: 2026-10-22
updated: 2026-10-22
affects: [INV-TREE-1..7 (renamed INV-VAR-1..7), INV-BND-4, 00-overview.md, 03-variants.md, 05-refinement.md, 10-server-protocol.md, 12-storage.md, ADR-0011]
---

# PROP-0009: Name the fixed half the foundation and the mutating half the variant

Accepted by the user's request (2026-10-22): document the harness so that the part that is fixed
is called the **foundation** and the part that mutates is called a **variant**, in code, storage
and protocol as well as in prose.

## Problem
"Harness" meant two things: the package, and the editable "harness tree" that refinement
improves. A sentence such as "refinement changes the harness" did not say whether the compiler and
the gate could move. The answer is no, but nothing in the spec said so as a rule, and code, data
folders and server methods all carried the ambiguous word (`harnesses/`, `harnesses.*`,
`HarnessChoice`, `harnessScope`).

## Affected rules
- `INV-TREE-1`…`INV-TREE-7` (page 03): renamed `INV-VAR-1`…`INV-VAR-7`; meaning unchanged.
- `INV-BND-4`: "Trees, the prompt compiler and Wiki notes are synchronous" now says variants.
- New `INV-FND-1` and `INV-FND-2` (below).
- The server method group `harnesses.*` (page 10) and the data layout (page 12).

## Proposal
1. **Vocabulary.** *Foundation*: the fixed half (Pi hookup, compiler, sessions and the run
   recorder, gate, accounts, trust, the surface and validator, the refinement method, the extension
   points, the protocol). *Variant*: one tree of eight components (c1–c8) for one scope. *Head*,
   *version*, *lineage*, *candidate* and *adopt* keep their meaning and now qualify a variant. The
   glossary is in the spec index.
2. **New invariants.**
   - `INV-FND-1` Only a variant mutates. No edit, improver session or adoption changes foundation
     code, the surface, the validator or an invariant.
   - `INV-FND-2` A variant changes only by committing a new validated version; refinement moves a
     head only when a person adopts. There is no other door.
3. **Code.** `src/tree/` becomes `src/variant/`. `Tree`→`Variant`, `HarnessChoice`→`VariantChoice`,
   `TreeTrust`→`VariantTrust`, `readTree`/`writeTree`→`readVariant`/`writeVariant`,
   `seedTree`→`seedVariant`, `RunRecord.harnessScope|harnessVersion`→`variantScope|variantVersion`,
   `Materialised.tree`→`Materialised.files`, the `sessions.run` input `harness`→`variant`,
   `ContextPack.harness`→`variant`, source kind `harness`→`variant`, the built-in plugin `harness`
   (title Harness)→`variant` (title Variant), error code `harness_invalid`→`variant_invalid`.
   Unchanged: `RunRecord.harness` (the engine name, `pi`), `PI_SURFACE`, `SurfaceSpec`, the `harness.*`
   server group (status and methods of the whole harness), and the Pi session-tree UI names
   (`SessionTreeNode`, `navigateTree`, `/tree`).
4. **Storage.** `harnesses/<scope>/`→`variants/<scope>/`, `versions/<fp>/tree/`→`…/variant/`,
   `tree-plugin-trust.json`→`variant-plugin-trust.json`, library `harnesses/<task>/harness/`→
   `variants/<task>/variant/`, refinement `refine/<id>/harnesses/`→`variants/`.
5. **Protocol.** `harnesses.*`→`variants.*`, notice `harnesses.changed`→`variants.changed`, the
   `harness` parameter of `sessions.run`, `context.compile`, `plugins.inventory`→`variant`, the
   `tree` parameter and field of the former `harnesses.*` methods→`variant`, `treeDir`→`variantDir`.
6. **Deliberate exception.** The improver prompts and the evidence folder's `harness/`,
   `base_harness/` names keep the Harness² paper's wording. They are method text; changing them
   would change refinement and its tests (`INV-REF-3`).

## Alternatives
- *Docs only, keep the names.* Cheaper, but the ambiguity stays in every API a host reads.
- *Rename components, not the tree.* Versions and adoption always act on a whole tree, so a
  component-level "variant" would not match how the system works.
- *Do nothing.*

## Consequences
Breaking for hosts: package version 5.0.0. Hosts must call `variants.*`, pass `variant` instead of
`harness`, read `variantScope`/`variantVersion`, and use plugin id `variant`. No aliases are kept.
Stored data moves on `open` (below); the prompt text and its stable prefix do not change.

## Migration
`open()` runs `migrateVariantLayout` (idempotent; never overwrites) and the trust file moves when
`VariantTrust` is created. Run records written with `harnessScope`/`harnessVersion` still load
(`upgradeRunRecord`). Finished refinement records under `harnesses/` stay readable and adoptable.
To undo, rename the folders back and use the previous release.

## Checks
`npm run typecheck`, `npm test` (including `variant/migrate.test.ts`), `npm run prove`, the demo
refinement, and the App's and Evaluation's checks after they adopt the new names.
