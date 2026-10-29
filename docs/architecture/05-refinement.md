# 05 Refinement

## Purpose

Refinement improves a variant from evidence of how it ran, with model weights fixed
(Harness²). On one task it runs the current variant, lets improver sessions edit it, probes each
candidate, composes the best behaviours, and picks one final output without ever seeing a score.
A person adopts the result. Adopted variants and their lessons go to an experience library that the
next task's improvers read.

## Components

| Type / function | Module | Role |
|---|---|---|
| `Refinements` | `refine/service.ts` | `start`, `taskFromRun`, `wait`, `get`, `list`, `cancel`, `candidates`, `candidateDiff`, `candidateOutput`, `adopt`, `library`, `libraryEntry`, `forget`. |
| `runRefinement` | `refine/runner.ts` | One refinement end to end; writes `summary.json`. |
| `runMatrix` | `refine/suite.ts` | Evaluates variant versions on a task set without refining: one probe execution per version × task, recorded as `matrix.json` with comparability keys. Reads with `readMatrix`. |
| recursion | `refine/recursion.ts` | Parallel (`agg`) and sequential (`seq`) modes; stages `INV`, `DOM`, `AGG`, `COMPOSE`. |
| `Ledger` | `refine/ledger.ts` | Budget identity: R = 4k rollouts, P = 3k improver sessions. |
| evidence | `refine/evidence.ts` | Builds the evidence folder and guards it against grader output. |
| selection | `refine/selection.ts` | Blind choice among anonymised outputs, then reflection. |
| `Library` | `refine/library.ts` | The experience library per scope and area. |
| `PiExecutor`, `PiImprover` | `refine/pi.ts` | Executions and improvers as ordinary harness runs, triggers `probe` and `improver`. |
| `RefineHost` | `refine/host.ts` | The application's part (page 01, surface 7). The default host replays a git snapshot in a shared clone (`prepareSnapshotWorkspace`). |
| `snapshotWorkingTree` | `worktrees/snapshot.ts` | The working tree as a typed turn found it, as a commit (PROP-0052). |
| prompts | `refine/prompts.ts` | Improver missions. |

## Method

```text
base variant ──► k base executions (probe runs, isolated workspaces)
          ──► evidence folder (task, source, trajectories, deliverables, variant, library, pool)
          ──► improvers: k INV (how the agent works) + k DOM (what a practitioner knows)
          ──► probe each candidate ──► k compositions from behavioural contrasts ──► k finals
          ──► blind selection among anonymised outputs ──► reflection ──► candidate for adoption
```

Parallel mode explores wider; sequential mode refines deeper. Both cost R = 4k executions and
P = 3k improver sessions. An invalid proposal gets one retry with the validator's message
(`STAGE_ATTEMPTS = 2`), then inherits the current variant.

An **evaluation matrix** is the measurement half on its own: `runMatrix` runs every
`{variant version × task}` pair through the same `Executor` contract — no improver, no selection,
no adoption, and an empty or failed execution is an honest row. Every row records
deliverability (`ok`, `delivered`) and cost, plus its comparability keys (task-prompt hash,
executor name, package version, variant fingerprint), so matrices taken across variant versions or
package commits are diffable directly. An evaluation never moves a head, and it inherits the
answer-free rule: a variant or record carrying grader output is refused before any execution
(`INV-REF-1`).

## Contracts

- `start({ task: { id, scope, prompt, ... }, k?, mode?: 'parallel' | 'sequential', baseVersion?, improver?, executor?, retainWorkspaces? })`
  returns `{ id }` at once; progress arrives as `refine.changed` and `refine.event` notices.
- With `retainWorkspaces: true` (default `false`), each execution's workspace — base, candidate
  and final — is copied whole to `rollouts/<label>/workspace/` after its run settles and before
  the host's `cleanup`. Binary and hidden files are kept, and symbolic links are copied as links.
  A failed copy is recorded as `workspaceError` in `rollout.json` and never fails the execution.
  `candidates(id)` reports each execution's `workspace` path, or `null` (PROP-0002).
- `executor: { model?, effort?, accountId?, poolId? }` names how executions run. For each value
  the host's `session(...)` wins, then `executor`, then the account default. `summary.json`
  records `settings: { executor, improver }` as started; each probe run's record holds what it
  resolved (PROP-0003).
- `adopt(id, { label?, tag? })` commits the chosen (or named) candidate as the scope's head with
  source `refinement`, records `tunedFor` from the model its execution ran on, and tags it when
  asked. It refuses while any plugin code in it is untrusted, and checks the tag before committing.
- `taskFromRun({ runId? | sessionId?, nativeSessionId?, guidance? })` builds a task that replays
  one turn a person typed: its request text, the scope its variant came from, and its
  `workspaceSnapshot` as `task.workspace`. With a session it takes the latest typed turn; with a
  native session id it also finds turns recorded before the terminal restarted on another version.
  It refuses a run something else started, a run with no variant, and a run with no snapshot, and
  lists what the replay leaves out (attachments, untracked files the snapshot omitted).
- `task.workspace: { kind: 'git-snapshot', repo, commit }`: the default host prepares each
  execution as a `--shared` clone of `repo` checked out at `commit`, with HEAD and the index at the
  commit's parent, so tracked edits, deletions and new files look as they did. Ignored files named
  by `.worktreeinclude` are copied from the repository as it is now. The person's repository gains
  no worktree, ref or file.
- `task.guidance`: where the person asked improvers to look, at most 2,000 characters, refused when
  it names measurement (`checkGuidance`). It is added to the INV, DOM, aggregate and compose
  missions as a focus block that directs attention and keeps `KEEP_BASE` valid, and recorded on the
  summary. It never reaches the selector or the reflector.
- `candidateDiff(id, label)` and `candidateOutput(id, label)` return one candidate's file changes
  from the base and what its execution produced, for review before adopting.
- Executions run as `sessions.run` with `trigger: 'probe'`, `automatic: true`, in the host's
  workspace. Improvers run with `trigger: 'improver'`, `automatic: true`, file tools only, no
  providers, no connected apps, no harness tools, no variant, in a temporary copy of the evidence.

## Invariants

- **INV-REF-1** Refinement is answer-free. No rubric, score, grader output or reviewer verdict
  reaches an improver, the selector or the library. `refine/evidence.ts` guards every evidence
  folder (`GRADER_VERDICT_MARKERS` as a tripwire) and `assertTreeHasNoGraderVerdicts` guards the
  library. Retained workspaces are output for measurement after the fact; evidence, selection,
  reflection and the library never read them.
- **INV-REF-2** The selector sees only the request, the source and the outputs, shuffled under
  arbitrary ids. It never sees a harness, a trajectory, a verdict or the person's guidance.
- **INV-REF-3** The budget identity R = 4k, P = 3k holds in both modes (`Ledger.assertIdentity`).
  A change to the method changes both modes and their tests together.
- **INV-REF-4** Refinement never acts in the world. Executions are unattended `probe` runs in a
  folder the `RefineHost` prepared; anything that needs a person is refused at the gate, never
  queued.
- **INV-REF-5** Improvers have file tools only and work on a copy of the evidence.
- **INV-REF-6** Refinement never moves a head by itself. Only `adopt`, a person's action, does, and
  only with all plugin code trusted (`INV-VAR-5`).
- **INV-REF-7** The library carries whole adopted variants with an evidence-backed lesson, never a
  summary in place of the variant.
- **INV-REF-8** Per-observation truncation of trajectories is never below `MIN_OBS_TRUNC`
  (10,000 characters); lower values fabricate defects.

## Data

```text
<data root>/refine/<id>/      summary.json, task.json, variants/<label>/, rollouts/<label>/,
                              sessions/<label>/, context/, selection/, reflection/, improver/
<data root>/refine/<id>/rollouts/<label>/workspace/    only with retainWorkspaces
<data root>/refine/<id>/      matrix.json, suite.json   (evaluation matrices; see above)
<data root>/library/<scope>/<area>/INDEX.md
<data root>/library/<scope>/<area>/variants/<task>/{variant/, EXPERIENCE.md}
```

## Source map

In the terminal, `/refine [--k N] [--mode parallel|sequential] [--model id] [--executor-model id]
[guidance]` replays the latest request typed in this conversation. It shows the request, its
snapshot, the focus, the run count (4k executions, 3k improver sessions, selection and reflection)
and the models, asks, then runs in the background with a status item. Executions use this chat's
model unless `--executor-model` names another; `--model` sets the improver's. `/refine status`,
`/refine stop` and `/refine review` follow it; review marks the selector's pick, shows each
candidate's changes and output, and adopts any candidate, then switches the conversation to it.

`src/refine/*.ts`. Method origin: Harness² (`harness2/core/{recursion,ledger,selection,library,context}.py`,
Apache-2.0). The evaluation matrix is this harness's addition (`refine/suite.ts`), shaped by the
same executor contract and demo executor. Try it with no model: `npm run build && node dist/cli.js refine demo --k 2`,
or evaluate a matrix with `node dist/cli.js refine matrix --demo [--data <root>] [--out <file.json>]`.
