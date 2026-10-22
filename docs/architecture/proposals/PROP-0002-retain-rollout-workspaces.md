---
id: PROP-0002
title: Opt-in retention of each refinement execution's workspace
status: Implemented
created: 2026-10-21
updated: 2026-10-21
affects: [05-refinement.md, 10-server-protocol.md, 12-storage.md, INV-REF-1]
---

# PROP-0002: Opt-in retention of each refinement execution's workspace

## Problem

An external measurement of refinement must grade the files that the base executions and the
chosen final produced. Examples are a `.docx` memo, an `.xlsx` model, or a repository a verifier
runs tests in. Today those files are gone by the time the refinement finishes:

- `PiExecutor.execute` (`src/refine/pi.ts:83-119`) runs in the host's workspace, then always calls
  `workspace.cleanup()` in `finally`.
- `DEFAULT_REFINE_HOST.prepareWorkspace` (`src/refine/host.ts`) removes its temporary folder in
  that cleanup.
- Only `defaultDeliverable` survives, under `rollouts/<label>/deliverables/`. It keeps the reply and
  the *text* files that changed, and drops binary files (`readable` rejects any buffer containing
  `0`). It also stops at `FILES_LIMIT`.

An application can work around this by supplying its own `RefineHost` in-process. A client of the
server protocol cannot: `refine.start` has no host parameter, and it should not have one.

The request comes from the Evaluation repository. It needs to replicate the Harness² paper's
benchmarks (JobBench, LAB, WorkBuddy-Bench) and grade the base executions and the chosen
execution after selection, as upstream `harness2-judge` and `harness2-judge --bases` do.

## Affected rules

- 05 Contracts: "`start({ task: { id, scope, prompt, ... }, k?, mode?: 'parallel' | 'sequential',
  baseVersion?, improver? })` returns `{ id }` at once".
- 05 Data: `<data root>/refine/<id>/  summary.json, task.json, harnesses/<label>/, rollouts/<label>/, ...`.
- 10 Server protocol: the `refine.start` parameters.
- INV-REF-1 (unchanged, restated so it covers the new folder): "No rubric, score, grader output or
  reviewer verdict reaches an improver, the selector or the library."

## Proposal

**05 Contracts** become:

- `start({ task, k?, mode?, baseVersion?, improver?, retainWorkspaces? })`. When `retainWorkspaces`
  is `true`, each execution's workspace is copied to `rollouts/<label>/workspace/` once the run has
  settled and before the host's `cleanup` runs. The copy is whole: binary files, hidden files and
  nested folders. Symbolic links are copied as links and are not followed. The default is `false`,
  which keeps today's behaviour.
- The option covers base, candidate and final executions alike. `refine.candidates` reports
  `workspace: '<path>' | null` on each execution, so a caller can find it without knowing the
  layout.
- A failed copy is recorded as `workspaceError` in `rollout.json`. It never fails the execution or
  the refinement.

**05 Data** gains `rollouts/<label>/workspace/`, which exists only with `retainWorkspaces`.

**INV-REF-1** gains one sentence: "Retained workspaces are output for measurement after the fact.
Evidence, selection, reflection and the library never read them." The evidence builder keeps
reading `deliverables/` only. A test asserts that no evidence folder contains a path under
`workspace/`.

**10 Server protocol.** `refine.start` accepts `retainWorkspaces: boolean`. The CLI gains
`refine run ... --retain-workspaces`.

The option names no application concept, and every host benefits from it, including the default
host and an application's own host.

## Alternatives

- **Do nothing; the evaluator supplies a `RefineHost` whose `cleanup` is a no-op.** This only
  works in-process. Evaluation drives the harness through the server and the CLI, as its
  production adapters do. It would have to embed the harness as a library, which differs from the
  production path it is meant to measure.
- **Let `deliverable` keep binary files.** This changes what improvers and the selector see:
  binary bytes in the evidence, and a larger pool. That is a change to the method itself, not to
  measurement.
- **Retain only the chosen final.** The base arm is measured on the base executions, as in
  upstream `--bases`, so they are needed too. Retaining every execution is simpler and costs only
  disk.

## Consequences

- **Applications:** none, unless they opt in. A host's own `cleanup` still runs after the copy.
- **Stored data:** opted-in refinements grow by about R = 4k workspace copies. This is
  disk-heavy for large sources. The option stays opt-in for that reason, and the docs say so.
- **Server protocol:** one optional parameter and one optional field on candidate views. Both are
  additive. The App's sidecar schemas need the optional `workspace` field.

## Migration

None. Existing records have no `workspace/` folder, and their candidate views report `null`.
Undoing the change means removing the option; retained folders stay as inert files.

## Checks

- A unit test: a fake executor run with `retainWorkspaces` keeps a binary file and a nested
  folder under `rollouts/<label>/workspace/`. Without the option, the folder is absent.
- A unit test: evidence folders never include `workspace/`, so the INV-REF-1 tripwire still holds.
- `npm run typecheck`, `npm test`, `npm run prove` (the CLI flag), and
  `node dist/cli.js refine demo --k 2 --retain-workspaces`.
- App: `npm run typecheck`, `npm test`, `npm run check:layers`, and `cd src-tauri && cargo test`.
  The sidecar schema test parses the new field.
