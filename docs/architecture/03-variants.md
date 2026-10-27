# 03 Variants

## Purpose

A **variant** is the part of the harness that is allowed to change: everything that shapes an
agent's behaviour apart from the model, the application's own sections and the foundation
(page 00). It is eight components (c1–c8, after Harness²). Each caller scope has
content-addressed, validated, immutable versions of its variant and a head, the variant it runs
now. A run pins one version. Refinement (page 05) proposes new variants; a person adopts them.

What a variant may contain is fixed by the foundation: the surface (`PI_SURFACE`), the validator
and the always-on cap. A variant can change what the agent is told and which skills, scripts,
subagents and plugins it may load. It cannot change the prompt compiler, the gate, the run
recorder, accounts or trust.

Earlier documents called this the "harness tree" and its invariants `INV-TREE-n`; those are now
`INV-VAR-n`.

## Components

The surface is `PI_SURFACE` (`variant/surface.ts`), the one surface this harness runs.

| c | Component | Path in the variant | Reaches a run | Group |
|---|---|---|---|---|
| c1 | System prompt | `systemprompt.md` | always (prompt section `system`, order 25) | context |
| c2 | Guardrails | `guardrails.md` | always (`guardrails`, 40) | context |
| c3 | Memory | `memory.md` | always (`memory`, 45) | context |
| c4 | Tool guidance | `tool_guidance.md` | always (appended to the `tools` section) | tool interface |
| c5 | Subagents | `sub_agents/<name>/AGENT.md` | own context; instruction-only agent profiles, listed with the other profiles in `subagents` (64, PROP-0029) | orchestration |
| c6 | Skills | `skills/<name>/SKILL.md` (+ `scripts/`) | on demand, loaded by Pi as skills | context |
| c7 | Scripts | `scripts/<name>.py` or `.mjs` | on demand, listed in `scripts` (66) | tool interface |
| c8 | Plugins | `plugins/<name>.ts` | inside the tool loop, as Pi extensions | middleware |

| Type / function | Module | Role |
|---|---|---|
| `Variant` (path → text), `SurfaceSpec`, `ComponentInfo` | `variant/surface.ts` | The editable surface and its patterns. |
| `validate`, `readVariant`, `writeVariant`, `diffSummary`, `applyEdit`, `autotrigger` | `variant/variant.ts` | Validation and editing. |
| `commit`, `seed`, `restore`, `head`, `lineage`, `fingerprint` | `variant/store.ts` | Versions and the head. |
| `materialise`, `resolve`, `VariantChoice`, `Materialised` | `variant/materialise.ts` | Turns a version into prompt sections, skill paths and extension paths for one run. |
| `VariantTrust` | `variant/trust.ts` | Which plugin code a person trusted, by hash; which scopes let probes run improver code. |
| `seedVariant` | `variant/seed.ts` | A first variant for a scope. |
| component library | `variant/components.ts` | Reusable skills, prompts and rules under `registry/` and built-in folders. |

## Contracts

- **`VariantChoice`**: `{ scope, version? }` (a scope's head or one version) or `{ dir, scope? }`
  (a variant on disk, read and never written, such as a refinement candidate).
- **Version source** (`VersionSource`): `seed`, `edit`, `refinement`, `import`, `restore`.
- **Fingerprint**: first 16 hex characters of SHA-1 over sorted `path\0text\0` pairs.
- **Validation** (`validate`) refuses a variant when: always-on text (c1–c4) exceeds 24,000
  characters; a file is off the surface; a skill lacks `description:` or its `name:` differs from
  its folder; a skill is never named in the always-on text; a subagent lacks `description:`; a
  script does not compile; a plugin has no default export; an always-on file or skill invokes a
  script that is not in the variant.

## Invariants

- **INV-FND-1** Only a variant mutates. No edit, improver session or adoption changes foundation
  code, the surface, the validator or an invariant; those change by release, with a proposal.
- **INV-FND-2** A variant changes only by committing a new validated version (`commit` →
  `validate`, `INV-VAR-2`), and a refinement moves a head only when a person adopts
  (`INV-REF-6`). There is no other door.
- **INV-VAR-1** Variant instructions are versioned per scope. The application adds its own sections through `Launch` (page 01). The release-owned `plugin-authoring` skill is also available on demand in structured and terminal sessions, including existing variants; its body is not always-on. A variant skill with the same name takes precedence. It is shipped as a package resource and does not mutate pinned versions.
- **INV-VAR-2** Every saved version is validated (`commit` → `validate`). An invalid variant is
  refused with every problem listed.
- **INV-VAR-3** A version is never edited. A change is a new version; `restore` moves the head
  and appends to `restores.jsonl`.
- **INV-VAR-4** A run resolves its variant once and pins it; a child run or later turn uses the same
  files even if the head moves. A child whose agent profile names another variant resolves and
  pins that one when it starts (PROP-0029).
- **INV-VAR-5** c8 plugin code loads only when its exact text is trusted (SHA-256 in
  `variant-plugin-trust.json`). A changed file asks again. The one exception: a refinement probe may
  run improver-written code for a scope whose person allowed it (`probeCode`), and adopting that
  variant still requires the code trusted.
- **INV-VAR-6** The always-on cap exists because every always-on character costs every run.
  Raising it is an architecture change.
- **INV-VAR-7** Variant code is synchronous (`INV-BND-4`).

## Data

```text
<data root>/variants/<scope>/
  versions/<fingerprint>/variant/<rel>
  versions/<fingerprint>/version.json
  head.json
  lineage.jsonl
  restores.jsonl
<state dir>/variant-plugin-trust.json
<data root>/registry/{skills,prompts,rules}/   (component library)
```

## Source map

`src/variant/*.ts` (`migrate.ts` renames state written before PROP-0009 on `open`). Method origin: Harness² (`harness2/core/tree.py`, Apache-2.0).

## Terminal inspection

The resource browser retains the materialised preparation snapshot and labels it pinned. The
current scope head is separately labelled latest saved; browsing and comparison never rematerialise
the head as the running variant. Directory-backed variants remain browse-only. Library additions
use the existing validated commit door and affect future terminals.
