# 03 Harness trees

## Purpose

A harness tree is everything that shapes an agent's behaviour apart from the model and the
application's own sections: eight components (c1–c8, after Harness²). Each caller scope has
content-addressed, validated, immutable versions and a head. A run pins one version. Refinement
(page 05) proposes new versions; a person adopts them.

## Components

The surface is `PI_SURFACE` (`tree/surface.ts`), the one surface this harness runs.

| c | Component | Path in the tree | Reaches a run | Group |
|---|---|---|---|---|
| c1 | System prompt | `systemprompt.md` | always (prompt section `system`, order 25) | context |
| c2 | Guardrails | `guardrails.md` | always (`guardrails`, 40) | context |
| c3 | Memory | `memory.md` | always (`memory`, 45) | context |
| c4 | Tool guidance | `tool_guidance.md` | always (appended to the `tools` section) | tool interface |
| c5 | Subagents | `sub_agents/<name>/AGENT.md` | own context, listed in `subagents` (64) | orchestration |
| c6 | Skills | `skills/<name>/SKILL.md` (+ `scripts/`) | on demand, loaded by Pi as skills | context |
| c7 | Scripts | `scripts/<name>.py` or `.mjs` | on demand, listed in `scripts` (66) | tool interface |
| c8 | Plugins | `plugins/<name>.ts` | inside the tool loop, as Pi extensions | middleware |

| Type / function | Module | Role |
|---|---|---|
| `Tree` (path → text), `SurfaceSpec`, `ComponentInfo` | `tree/surface.ts` | The editable surface and its patterns. |
| `validate`, `readTree`, `writeTree`, `diffSummary`, `applyEdit`, `autotrigger` | `tree/tree.ts` | Validation and editing. |
| `commit`, `seed`, `restore`, `head`, `lineage`, `fingerprint` | `tree/store.ts` | Versions and the head. |
| `materialise`, `resolve`, `HarnessChoice`, `Materialised` | `tree/materialise.ts` | Turns a version into prompt sections, skill paths and extension paths for one run. |
| `TreeTrust` | `tree/trust.ts` | Which plugin code a person trusted, by hash; which scopes let probes run improver code. |
| `seedTree` | `tree/seed.ts` | A first tree for a scope. |
| component library | `tree/components.ts` | Reusable skills, prompts and rules under `registry/` and built-in folders. |

## Contracts

- **`HarnessChoice`**: `{ scope, version? }` (a scope's head or one version) or `{ dir, scope? }`
  (a tree on disk, read and never written, such as a refinement candidate).
- **Version source** (`VersionSource`): `seed`, `edit`, `refinement`, `import`, `restore`.
- **Fingerprint**: first 16 hex characters of SHA-1 over sorted `path\0text\0` pairs.
- **Validation** (`validate`) refuses a tree when: always-on text (c1–c4) exceeds 24,000
  characters; a file is off the surface; a skill lacks `description:` or its `name:` differs from
  its folder; a skill is never named in the always-on text; a subagent lacks `description:`; a
  script does not compile; a plugin has no default export; an always-on file or skill invokes a
  script that is not in the tree.

## Invariants

- **INV-TREE-1** A harness tree is the only thing in the harness that shapes an agent's
  instructions. The application adds its own sections through `Launch` (page 01); no other
  harness code adds instruction text.
- **INV-TREE-2** Every saved version is validated (`commit` → `validate`). An invalid tree is
  refused with every problem listed.
- **INV-TREE-3** A version is never edited. A change is a new version; `restore` moves the head
  and appends to `restores.jsonl`.
- **INV-TREE-4** A run resolves its tree once and pins it; a child run or later turn uses the same
  files even if the head moves.
- **INV-TREE-5** c8 plugin code loads only when its exact text is trusted (SHA-256 in
  `tree-plugin-trust.json`). A changed file asks again. The one exception: a refinement probe may
  run improver-written code for a scope whose person allowed it (`probeCode`), and adopting that
  tree still requires the code trusted.
- **INV-TREE-6** The always-on cap exists because every always-on character costs every run.
  Raising it is an architecture change.
- **INV-TREE-7** Tree code is synchronous (`INV-BND-4`).

## Data

```text
<data root>/harnesses/<scope>/
  versions/<fingerprint>/tree/<rel>
  versions/<fingerprint>/version.json
  head.json
  lineage.jsonl
  restores.jsonl
<state dir>/tree-plugin-trust.json
<data root>/registry/{skills,prompts,rules}/   (component library)
```

## Source map

`src/tree/*.ts`. Method origin: Harness² (`harness2/core/tree.py`, Apache-2.0).
