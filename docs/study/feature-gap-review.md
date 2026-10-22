# Harness feature-gap review

**Scope:** What `@xingular/harness` provides compared with the agent systems in the local harness study. This is a feature-gap review, not a parity score. Comparisons refer to the studied snapshots; the deeper OpenHands and Claude Code audits are still marked pending in the [study index](00-index.md).

## Summary

The Harness is a generic single-run runtime, not a task manager or long-running workflow engine. Some apparent gaps are deliberate layer boundaries: the architecture assigns product tasks, schedules, teams, worktrees, and UI to the embedding application. The run record has an opaque `goal` string, but no goal lifecycle or progress model. See [00 Overview](../architecture/00-overview.md#layers) and [02 Sessions and runs](../architecture/02-sessions-and-runs.md).

| # | Capability missing from the Harness | Current state and comparison | Appropriate owner |
|---:|---|---|---|
| 1 | **First-class task lifecycle** — create, assign, track status, dependencies, review, and acceptance | Normal sessions track runs; `RefineTask` is for harness-tree refinement, not product work. OMP has a task-delegation tool. | **Application** |
| 2 | **Persistent goals and progress** — goal hierarchy, checklist, and durable progress | Plan mode produces a proposed plan, not tracked progress. `goal` on a run is opaque metadata. OpenCode has per-session todos; OMP exposes a goal helper. | **Application**, optionally through a tool provider |
| 3 | **Long-running job scheduler** — durable queue, cron/event triggers, deadlines, retries, and leases | Sessions can run asynchronously, but the Harness has no durable scheduler. The OpenHands study identifies scheduling in a separate automation project. | **Application** |
| 4 | **Crash-safe continuation** — resume from a checkpoint after a process or machine restart | Run events and Pi history persist, and terminal history can be resumed manually. However, startup marks active runs interrupted; the Harness does not restart model work. | **Harness + application**: recovery contract plus requeue policy |
| 5 | **Automatic cross-run memory consolidation** — extract useful task state and lessons from completed runs | The Harness has Wiki notes, history, and a refinement experience library, but no automatic task-state consolidation pipeline. OMP's study describes background memory extraction and consolidation. | **Harness** for generic memory; **application** for task state |
| 6 | **Team and work-queue orchestration** — persistent workers, assignments, dependencies, and shared coordination | Harness subagents are fresh parent-child runs with result delivery, not a persistent team or shared queue. OMP has task-worker machinery; product-level coordination belongs outside the Harness. | **Application** |
| 7 | **Managed per-task sandbox/workspace** — containers, worktrees, snapshots, and rollback | The host supplies the working folder and tools; the Harness tool gate is not an OS sandbox. The study contrasts this with OpenHands/SWE-agent containers and OMP worktrees. | **Application/host** |
| 8 | **Native browser and computer interaction** | Web search/fetch can be provided as tools, but browser or computer control is not built in. Plan-mode text mentioning managed controls is recorded as known drift (D-6). | **Application**, through tool providers and policy |
| 9 | **Goal-specific verification and acceptance** — tests, graders, and a “done” gate | The refinement matrix records execution and deliverability; it does not grade whether a user's goal was achieved. Frozen task grading belongs in Evaluation. | **Evaluation/application** |
| 10 | **Aggregate operations dashboard and budgets** — cross-run cost limits, alerts, and health views | The Harness records per-run events and usage. It has no built-in aggregate dashboard; an optional budget-guard plugin partially covers per-run limits. OMP's study describes a local stats dashboard. | **Application UI**, using Harness run data |

## Status (2026-10-22)

The Harness-owned parts of three gaps have landed. The application-owned parts and the other
seven gaps are unchanged.

| # | What landed in the Harness | Taken from | Still the application's |
|---:|---|---|---|
| 2 | `checklist_write`: the model's whole checklist as a `checklist.updated` run event, read with `runs.checklist` ([PROP-0006](../architecture/proposals/PROP-0006-run-checklist.md)) | dsh `todo_write` (whole-list replace, three statuses, replayed from the log); OpenCode `todowrite` (usage rules in the tool description) | Goal records, goal hierarchy, progress across runs, showing the checklist |
| 4 | `continueFrom` and `runs.continuation`: a stopped run is continued as a new run with the same account, tree version and capabilities, and the model is told where it stopped; `Recovery.interruptedRunIds` ([PROP-0007](../architecture/proposals/PROP-0007-run-continuation.md)) | Every peer's "never restart silently" rule; dsh's durable log as the checkpoint; OpenHands' requeue outside the agent | The requeue policy: which runs to continue, when, and whether to ask first |
| 5 | The opt-in `lessons` plugin: a read-only reflection after a completed run may keep one lesson in the Wiki under `library/lessons/` ([PROP-0008](../architecture/proposals/PROP-0008-lessons-from-runs.md), [ADR-0010](../decisions/ADR-0010-lessons-in-the-wiki.md)) | harness²'s reflector (cue → lesson, `NO_ENTRY`, never task facts, answer-free guards); OMP's background extraction and caps | Task state and its consolidation; a switch for the plugin in its UI |

## Recommendation

For products that need autonomous long-running work, start with an application-owned task/goal model and scheduler, then define how they request safe continuation of Harness runs. Keep task and schedule concepts out of the Harness itself; its architecture deliberately assigns them to the application. A useful first sequence is: (1) task and goal records with acceptance criteria, (2) durable scheduling and human handoff, (3) explicit restart/recovery policy, then (4) isolated workspaces and an evaluation gate.

## References

- Harness ownership and application boundary: [00 Overview](../architecture/00-overview.md#layers), [02 Sessions and runs](../architecture/02-sessions-and-runs.md#invariants).
- Harness memory and refinement: [08 Memory and history](../architecture/08-memory-and-history.md), [05 Refinement](../architecture/05-refinement.md).
- Peer comparisons: [Tools](arms/02-tools.md), [Subagents](arms/03-subagents.md), [Memory](arms/06-memory.md), [Execution](arms/08-execution.md), [Observability](arms/09-observability.md), [wide comparison matrix](arms/00-matrix.md).
- Source inventories: [OpenHands](sources/openhands.md), [OMP](sources/omp.md), [SWE-agent](sources/swe-agent.md), [OpenCode](sources/opencode.md).
