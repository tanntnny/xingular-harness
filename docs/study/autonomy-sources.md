# Proactive autonomy precedents: OpenClaw, Paperclip, and Letta

Companion evidence for [STUDY-0002: proactive autonomy and three feature ideas](proactive-autonomy.md).

Research date: **2026-10-23**. Status: external evidence and design interpretation; this document changes no Harness contract or runtime behavior.

The useful combination is a readable mandate, a durable wake mechanism, explicit work ownership, and memory that improves between conversations. Scheduling alone supplies none of the judgment needed to identify valuable work. The three systems below implement different parts of that combination; their documentation and source establish mechanisms, not evidence that an unattended agent consistently improves a real product.

## Evidence and version boundaries

Official documentation, upstream code, and original research were inspected. Source links are pinned to these upstream snapshots where possible:

| System | Snapshot inspected | What the evidence establishes |
|---|---|---|
| OpenClaw | [`42c0d5a8`](https://github.com/openclaw/openclaw/commit/42c0d5a8f9d00e113c48090c3d259977e67b5b5a), 2026-10-22 | Automation, prospective memory, and consolidation contracts; selected implementation checks |
| Paperclip | [`def4726b`](https://github.com/paperclipai/paperclip/commit/def4726bea0e3b340457100038d80ca55c2b7d4f), 2026-10-22 | Routine dispatch, ownership protocol, accounting controls, and suppression logic |
| Letta Code | [`035bb8c8`](https://github.com/letta-ai/letta-code/commit/035bb8c8917b5dd94a3989d4adf04860a2ce8fea), 2026-10-22 | Reflection triggers, memory editing instructions, merge behavior, and retry controls |

Two freshness traps matter. OpenClaw's [fetched live heartbeat page](https://docs.openclaw.ai/heartbeat) described a system-owned monitor, while repository HEAD documents its migration into ordinary automation jobs. Paperclip's [live routine guide](https://docs.paperclip.ing/guides/projects-workflow/routines/) described coalescing as a queued follow-up, while its API reference and dispatch implementation finalize the incoming occurrence against existing work without creating another issue. This note uses the pinned source for those disputed details. [OpenClaw migration][o1], [Paperclip API][p2], [Paperclip dispatch][p3]

## OpenClaw: make recurring work inspectable

### Current direction: ordinary jobs replace a special heartbeat mechanism

At the inspected revision, legacy heartbeat monitors become editable automation jobs with schedules, prompts, scratch context, policies, and run history. Migration preserves identity and history and verifies the destination before retiring old configuration. Runtime no longer interprets `HEARTBEAT.md` or scratch `tasks:` blocks as schedules. Initial setup provisions one owner-associated proactive check; deleting it is lasting because a provisioning receipt prevents its recreation. The worker implementation performs receipt inspection and job creation in a state transaction. [Migration and setup][o1], [`default-proactive-job.worker.ts:20`][o2]

**Interpretation:** an appealing Markdown checklist can express intent, but a machine-owned occurrence record should decide what is due. A self-editing checklist that also acts as the scheduler makes deleted tasks, concurrent edits, and restart behavior ambiguous. OpenClaw's evolution offers a stronger precedent than copying an old `HEARTBEAT.md` example.

### Keep the mandate readable; make updates and silence structured

Each job can retain private scratch context. Scratch updates require revision comparison; an agent rereads and reconciles a conflicting revision. During a scheduled turn, scratch and result actions are restricted to the current job. Scratch is prompt context, so its private storage does not make it an appropriate secret store. [Scratch contract][o3]

The model can produce no outward message while recording an outcome such as `no_change`, `progress`, `done`, `blocked`, or `needs_attention`. A quiet outcome stays in run history and bounded session context. Silence does not erase execution failure. Explicitly empty scratch can suppress a run when that policy is enabled; absent scratch has different semantics. These are small distinctions with large consequences for an unattended system's readability. [Scratch and quiet results][o3]

**Interpretation:** provide a compact human view of “what I care about” and a separate machine record of “what happened.” Show consequential changes and blocked work; let routine all-clear checks remain quiet but inspectable. Preserve the difference between a quiet success, a deliberate skip, and an error.

### Durable scheduling requires recovery rules, not merely persistence

OpenClaw documents persisted job definitions, runtime state, and history in shared SQLite state; its Gateway process must be running for schedules to fire. Startup reschedules overdue agent work rather than executing it during initialization, and the worker coalesces missed ticks. Execution and primary-delivery outcomes are persisted together before subsequent notification work. A terminal result recovers by exact run identity without replaying execution or delivery. [Runtime and recovery][o4]

For an interrupted, unchanged timed agent job before delivery, recovery permits one fresh attempt and asks the agent to reconcile prior effects. The documentation explicitly excludes an exactly-once guarantee for arbitrary interrupted tool effects. Unknown or possible delivery, command/script payloads, and event schedules have different replay rules. This is a useful honesty boundary: a durable scheduler cannot infer whether an external write succeeded just before a crash. [Run reconciliation][o4]

Policies support idle-only admission and timezone-aware active hours. The inspected migration also removes earlier heartbeat-specific duplicate suppression and no-route skipping. New designs should therefore state their own deduplication and delivery semantics rather than assuming a heartbeat label provides them. [Monitoring policies][o5], [Migration behavior][o1]

### Future intent is not all the same kind of state

OpenClaw distinguishes clock work, event-conditioned intent, and aspirations kept in readable notes with review dates. Standing intents live in agent SQLite state and are matched before eligible interactive replies using a keyword prefilter and authoritative scope, expiry, cooldown, and fire-budget checks. Matching does not call a model. Default cooldown, fire count, and expiry bound repeated reminders. Cancellation is explicit durable state. These intents react to eligible incoming turns; they are not independent background event monitors. [Standing intents][o6]

Its memory system additionally separates dated working notes, curated durable knowledge, and a human Dream Diary. Dreaming applies evidence and provenance gates before consolidation; the model chooses operations while a writer constructs grounded entries. Untrusted and system-derived candidates are excluded from promotion. Prior memory is backed up, and the diary records additions, merges, and supersessions; the diary itself is not promoted as evidence. [Memory organization][o7], [Consolidation and diary][o8]

**Interpretation:** track “when to act,” “what I believe,” and “what I learned” separately. Otherwise generated reports become their own evidence and stale intentions keep reappearing.

## Paperclip: organize autonomy around owned work

### Goals provide direction; assigned tasks select execution

Paperclip models organizations, goals, agents, projects, and issues. Its core concepts describe a goal-to-task hierarchy and atomic task checkout, with a conflict preventing two agents from owning the same issue. The current agent skill is stricter than a free-roaming assistant: it selects assigned work, prioritizes existing work before new todo items, skips blocked tasks without new context, and exits if nothing is assigned. A scoped wake can bypass general inbox discovery. [Core concepts][p1], [`SKILL.md:94`][p4]

This matters for the user's “knows what to do next” request: Paperclip demonstrates a durable work queue and allocation protocol. It does **not** establish that any worker should invent unbounded new work whenever idle. Autonomous opportunity discovery would require a separate product-level mandate, candidate selection process, and resource policy. That is a proposed extension, not an observed property of the worker protocol.

The skill asks for compact incremental context rather than full thread replay. A blocked-status comment without subsequent replies suppresses another checkout or comment. Progress should identify what changed and the next owner, and waiting for a human uses a saved interaction that can wake the assignee later. A prose claim that a watcher exists is insufficient: an actual scheduled continuation must exist. [Heartbeat procedure][p4]

### A routine creates accountable work with explicit overlap behavior

Routine definitions contain a readable title and description, assignee, project, optional goal, priority, triggers, and policies. They support schedule, webhook, and API activation, execution history, definition revisions, and optional revision checks on updates. Agents can manage routines assigned to themselves, while assignment to another agent is an operator capability. Webhook requests can use stable idempotency keys; acceptance means queued asynchronous work, not completion. [Routine API][p2]

At the inspected revision, `coalesce_if_active` finalizes the incoming occurrence as coalesced and links it to existing active execution; `skip_if_active` records a skip; `always_enqueue` creates separate work. The implementation checks for existing execution and handles the corresponding uniqueness conflict before creating and linking a new issue to an assignment wake. Catch-up is bounded, with an internal limit of 25; the scheduler has additional behavior for subhourly schedules. [Dispatch implementation][p3]

**Interpretation:** decide whether a missed tick represents discarded work, merged observation, or a required follow-up. Those are different semantics. A maintenance scan usually does not deserve a backlog entry for every missed hour.

### Suppress work that feeds on its own bookkeeping

Paperclip's activity gate can require external activity since the last dispatched non-skipped occurrence. It excludes the routine's own execution issues, its scheduler bookkeeping, and read/archive activity, while work by other agents on delegated tasks counts as external input. Quiet skipped occurrences do not advance the observation window. This supports a watcher that runs while genuine work continues and becomes cheap when the environment settles. [Activity-gated runs][p5]

Source also implements an independent no-progress wake throttle: after two consecutive successful runs without issue-visible progress, eligible empty wakes receive a two-minute cooldown that doubles up to thirty minutes. Fresh input, human comment wakes, and explicit operator resumption bypass it; agent-authored comment wakes remain throttled. Failures break the successful-no-progress streak so recovery is not mistaken for redundant polling. [Wake throttle implementation][p6]

**Interpretation:** durable “no new evidence” state is as valuable as a task queue. Otherwise one autonomous agent's status comment can become another agent's reason to run, producing activity without useful progress.

### Budgets must account for unfinished work

The inspected accounting source evaluates policies across organization, agent, and project scopes. It distinguishes recorded spend, held reservations, pending work, and unpriced usage, with policy-dependent blocking. Admission rechecks a held reservation before provider dispatch; budget enforcement pauses applicable scope and schedules cancellation through a durable path. This is more substantial than logging costs after a cron run completes. These are source-level controls, not a measurement that real provider spend can never overshoot a limit. [Budget admission and enforcement][p7]

**Interpretation:** a system allowed to discover its own work needs a resource envelope for discovery as well as implementation. Concurrent agents can exhaust a budget before any completed run reports a bill.

## Letta: improve future work during idle periods

### Use the current filesystem model, with historical sleep-time work as context

The 2025 sleep-time architecture used a primary agent and a separate memory editor. Letta's later first-party roadmap explicitly moves away from server memory tools and server-side sleep-time agents toward filesystem operations, context repositories, and runtime subagents. Current documentation describes MemFS as Markdown memory in an agent-owned Git repository. Root memories enter active context; deeper indexed directories can be read when needed. Memory subagents use worktrees to avoid blocking the foreground agent. [Historical design][l1], [Migration direction][l2], [Current MemFS][l3]

Current dreaming reviews recent conversations, extracts lessons, and updates memory. It can trigger after completed steps or compaction. The optional agent-review stage is another background conversation that can revise proposed edits; it consumes more tokens and does not require human approval. These are event/step triggers, not evidence of an always-running wall-clock daemon. Local schedules also require an active Letta session, whereas cloud schedules run in the managed environment. [Dream settings][l4], [Schedule execution targets][l5]

### Autonomous learning already includes editing procedures

The inspected reflection prompt prioritizes mistakes and corrections, preferences, durable facts, contradictions, and reusable workflows. It directs the agent to skip ephemeral or duplicate material, prefer existing procedures, limit skill changes, make no commit when nothing survives, and report exact memory changes and issues. It permits autonomous memory and skill edits within the memory directory, with a commit recording why. This is implemented instruction, not evidence that every learned rule improves later performance. [`reflection-v2.md:27`][l6]

The launcher prevents overlapping reflection for the same agent, skips empty transcript work, and suppresses automatic retries for invalid model configuration. Worktree integration handles dirty parent state and conflicts explicitly. Failed integration has exponential retry delay from one to thirty minutes and notification deduplication; that retry state is process-local and resets on restart. [Launcher][l7], [Worktree integration][l8], [Retry implementation][l9]

**Interpretation:** the bold precedent is letting experience edit future procedure without a human approving each memory diff. Git history makes those changes reviewable and reversible. It does not make them correct, authorize unrelated source edits, or justify letting a background learner rewrite its own resource and permission limits.

## What has actually been measured

The original sleep-time paper reports roughly five times less test-time compute at comparable accuracy on its stateful math variants, and amortized savings across related queries. Its software case study uses only 33 feature examples from two repositories and evaluates overlap with ground-truth modified files, not implementation correctness. Predictable future queries benefit more; the paper acknowledges the simplified split between preparation and later queries. These results motivate reusable preparation and memory, but do not establish reliable autonomous UI repair, product prioritization, or profitability. [Original paper, Sections 5–7 and Appendix D][r1]

TriggerBench finds proactive recall can degrade with longer context even when explicitly queried recall remains strong; enhanced reasoning can produce an excessive-reminder strategy. ProEvent evaluates synthetic ongoing chats and finds overaction and cancellation failures across tested systems. These benchmarks justify measuring missed opportunities **and** false actions, timing, cancellation, and cost. Their environments differ from this Harness; the findings are directional evidence rather than predicted local failure rates. [TriggerBench][r2], [ProEvent][r3]

## Design consequences for this research

The following are inferences from the precedents, not existing Harness features:

| Capability | Grounded precedent | Deliberate autonomy trade |
|---|---|---|
| Scheduled self-directed work | OpenClaw jobs plus Paperclip owned issues, activity gates, and budgets | Let the agent rank and start bounded local work from a standing mandate without a fresh human prompt |
| Human-readable operating intent | Readable routine descriptions, scratch, explicit standing intents, and outcome diaries | Let the agent revise working plans while preserving owner intent and an inspectable change history |
| Learning between sessions | Letta reflection, versioned memory, procedure edits, and optional agent review | Automatically apply learned procedures or candidate improvements while keeping changes attributable and reversible |

The novel opportunity is combining those mechanisms with real product evidence and a human-readable explanation of why the next action was selected. The studied sources do not establish an end-to-end system that identifies a product's highest-value UI defect from analytics, repairs it correctly, and invents a desirable feature without supervision. That remains a hypothesis requiring local evaluation.

The most informative first evaluation would replay real work episodes with known useful actions and explicit “do nothing” cases. Record whether the right work was chosen, duplicate or canceled work was suppressed, artifacts stayed reviewable, and spending matched value. A system that runs frequently while producing low-value changes has not demonstrated useful autonomy.

[o1]: https://github.com/openclaw/openclaw/blob/42c0d5a8f9d00e113c48090c3d259977e67b5b5a/docs/gateway/heartbeat.md#L27
[o2]: https://github.com/openclaw/openclaw/blob/42c0d5a8f9d00e113c48090c3d259977e67b5b5a/src/cron/default-proactive-job.worker.ts#L20
[o3]: https://github.com/openclaw/openclaw/blob/42c0d5a8f9d00e113c48090c3d259977e67b5b5a/docs/automation/cron-jobs/payloads.md#L268
[o4]: https://github.com/openclaw/openclaw/blob/42c0d5a8f9d00e113c48090c3d259977e67b5b5a/docs/automation/cron-jobs/how-it-works.md#L14
[o5]: https://github.com/openclaw/openclaw/blob/42c0d5a8f9d00e113c48090c3d259977e67b5b5a/docs/automation/cron-jobs/schedules.md#L61
[o6]: https://github.com/openclaw/openclaw/blob/42c0d5a8f9d00e113c48090c3d259977e67b5b5a/docs/concepts/standing-intents.md#L14
[o7]: https://github.com/openclaw/openclaw/blob/42c0d5a8f9d00e113c48090c3d259977e67b5b5a/docs/concepts/memory.md
[o8]: https://github.com/openclaw/openclaw/blob/42c0d5a8f9d00e113c48090c3d259977e67b5b5a/docs/concepts/dreaming.md#L106
[p1]: https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/docs/start/core-concepts.md
[p2]: https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/docs/api/routines.md
[p3]: https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/server/src/services/routines.ts#L1859
[p4]: https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/skills/paperclip/SKILL.md#L94
[p5]: https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/skills/paperclip/references/routines.md#L87
[p6]: https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/server/src/services/issue-rewake-throttle.ts
[p7]: https://github.com/paperclipai/paperclip/blob/def4726bea0e3b340457100038d80ca55c2b7d4f/server/src/services/budgets.ts
[l1]: https://www.letta.com/blog/sleep-time-compute/
[l2]: https://www.letta.com/blog/our-next-phase/
[l3]: https://docs.letta.com/concepts/memfs
[l4]: https://docs.letta.com/configuration/memory
[l5]: https://docs.letta.com/configuration/schedules
[l6]: https://github.com/letta-ai/letta-code/blob/035bb8c8917b5dd94a3989d4adf04860a2ce8fea/src/agent/subagents/builtin/reflection-v2.md#L27
[l7]: https://github.com/letta-ai/letta-code/blob/035bb8c8917b5dd94a3989d4adf04860a2ce8fea/src/cli/helpers/reflection-launcher.ts
[l8]: https://github.com/letta-ai/letta-code/blob/035bb8c8917b5dd94a3989d4adf04860a2ce8fea/src/agent/memory-worktree.ts#L363
[l9]: https://github.com/letta-ai/letta-code/blob/035bb8c8917b5dd94a3989d4adf04860a2ce8fea/src/cli/helpers/reflection-retry.ts
[r1]: https://arxiv.org/html/2504.13171v1
[r2]: https://arxiv.org/abs/2606.23459
[r3]: https://arxiv.org/abs/2607.17701
