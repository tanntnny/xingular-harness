---
id: PROP-0019
title: Harness-owned contextual side questions across surfaces
status: Proposed
created: 2026-10-24
updated: 2026-10-24
affects: [INV-RUN-1, INV-RUN-3, INV-RUN-5, INV-GATE-1, INV-PLG-1, INV-PLG-5, INV-CAP-1, INV-SRV-1, INV-SRV-2, INV-PAR-1, INV-PAR-2, 02-sessions-and-runs.md, 06-plugins-and-capabilities.md, 07-tools-and-the-gate.md, 10-server-protocol.md, 11-terminal.md, 14-surfaces-and-parity.md, 12-storage.md]
---

# PROP-0019: Harness-owned contextual side questions across surfaces

## Problem

`/btw` currently has two different execution paths. The terminal constructs a direct, in-memory Pi session in `src/terminal/tui/sideQuestion.ts`; it supplies at most six visible turns and 6,000 characters, names of tools called and a running flag, but no tool inputs or results. It has no Harness run record. The App assembles a different bounded snapshot and starts a separate, tracked `sessions.run` with trigger `side-question` (`App/docs/features/FEAT-0014-side-questions.md`). The parity register calls these one capability but lists no Harness owner method (`docs/parity.md`).

As a result, a question about an active task can miss relevant, already-public progress, the two surfaces have different observability and lifecycle, and follow-up questions have no shared contract. The checked-out studies and current official Codex/Claude Code documentation show useful alternatives: richer existing-conversation context, separate follow-up threads, and explicit forks/promotions. They do not justify giving a side question tools or copying hidden state.

## Affected rules

- **INV-RUN-1:** “A run pins one account, one variant version and one capability set when it starts. None of them changes during the run.” A side question needs a narrow exception: it pins the selected account and an empty capability set but has no variant (`variantVersion: null`), because it uses only the fixed Harness instruction and caller-supplied context.
- **INV-RUN-3:** “Every run event is validated against its schema, redacted, persisted, and only then relayed to listeners, in order.” Side-question events and any included context must use this contract.
- **INV-RUN-5:** “Unattended runs load no extension found on disk (`INV-PLG-1`), read no context files, and never ask a person: anything that would need approval is refused. A variant's own trusted plugins still load.” A side-question run needs a narrower, explicit resource-loading rule.
- **INV-GATE-1:** “Every tool call of every run passes the gate.” The proposed side-question run must have no tools to call, rather than relying on a client UI to prevent tool use.
- **INV-PLG-1:** “The harness is the only loader. A session or terminal loads exactly what `Plugins.loading` chose, with Pi's discovery switched off.” The dedicated restricted mode must remain inside the Harness loader.
- **INV-PLG-5:** “Everything model-visible belongs to a plugin.” The fixed side-question instruction must have an attributed Harness-owned descriptor.
- **INV-CAP-1:** “A capability set only narrows. `intersect` never adds access; a run's set is frozen when it starts (`INV-RUN-2`).” A side-question run freezes a restricted, no-tool capability set.
- **INV-SRV-1/2:** `src/server/methods.ts` is the host contract, and a method delegates to the same in-process API. A shared service requires an additive host surface.
- **INV-PAR-1/2:** A host capability is a Harness capability, and is complete only when both terminal and host surfaces pass acceptance. This replaces the current split ownership implied by the parity row and App feature document.

## Proposal

1. Add a generic Harness side-question service, with operations to start and interrupt a question. It is callable by the standalone terminal and by embedding hosts; its contract names no application or chat product. Each question is an independent Harness run using the normal account pinning, run-event validation, redaction and run-store path. It has a separate native history identity and is not a child/subagent of, or continuation of, the main run.
2. The caller supplies a validated, bounded `SideQuestionContext` projection. It may contain recent visible user/assistant text, the current user request, visible partial assistant text, run status, and short public tool-activity summaries. It must exclude hidden reasoning, attachments, credentials, raw tool arguments/results, and content from another conversation. Treat supplied conversation/tool text as context data, not as instructions that can expand authority. The exact limits are fixed and tested in implementation; the packer prioritizes the current request and newest useful context and reports when older context was omitted.
3. A side-question run uses the active conversation's selected account and model (and effort when supported), but its own one-use session identity and a fixed, attributed Harness side-question instruction. It records no variant (`variantVersion: null`) and freezes an empty capability set. Its dedicated launch path loads no tools, providers, connectors, subagents, project context files, user/variant plugin code or main-run native history. Pi discovery remains off and the Harness remains the only loader. This is the explicit side-question exception to variant pinning in `INV-RUN-1`; the run still pins its account and capability set. The restriction is enforced by the Harness, not by the terminal or App.
4. The side question and answer never enter, steer, stop or queue work on the parent conversation. They are recorded only in the independent side run's ordinary run record/events; clients may show that run in Trajectory/Usage. This deliberately aligns terminal observability with the App's existing run-backed behavior. No separate durable side-thread store is introduced.
5. Each surface may keep a bounded follow-up thread in volatile client state. Follow-ups can include earlier side questions/answers, but are not added to the parent transcript; clearing or exiting drops that thread. The UI can browse, copy and clear answers. Any future durable side history requires a separate proposal and explicit retention policy.
6. A later explicit “continue with tools” or “insert into main prompt” action may hand work to the existing subagent or composer path. It must never execute tools or modify the parent implicitly as part of answering `/btw`.
7. Update the capability register so the Harness side-question service is the owner and both terminal and App surfaces call the same contract. Preserve each surface's presentation; the App remains responsible for its dock and conversation selection, not side-run orchestration or context policy.

## Alternatives

- **Keep the terminal-only Pi session and raise its excerpt limits.** Smallest change, but leaves the App and terminal with separate semantics, no common privacy contract, and inconsistent run observability.
- **Send the full main session transcript, system prompt, tool catalog and tool results.** Similar to some studied implementations and can improve recall/cache reuse, but unnecessarily exposes hidden or sensitive content and blurs the no-tools boundary. Rejected.
- **Persist all side-question threads in a new store.** Enables durable topics, as in Oh My Pi, but adds storage, retention, deletion and cross-surface synchronization contracts. Defer; volatile follow-ups are sufficient for this proposal.
- **Keep `/btw` as an App-owned presentation only.** Conflicts with the accepted one-capability-surface rule and does not fix terminal parity. Rejected.

## Consequences

- Side-question requests and answers become ordinary, separately inspectable Harness run records. They remain absent from the parent transcript, but are not ephemeral from the run store; the UI and documentation must say this plainly.
- The Harness owns the generic context schema, bounds, restricted launch and lifecycle. The App supplies only a sanitized projection from state it owns and presents Harness results.
- A dedicated restricted launch path and an attributed first-party instruction descriptor are needed. `automatic: true` alone is not the contract because trusted variant plugins and other session resources have their own loading rules.
- No new persistent side-thread store or protocol version is required. Adding methods to an existing server group is additive under INV-SRV-1; terminal session-socket routing may also be needed for the standalone frontend.
- The terminal's current untracked side session changes to a tracked independent run with no variant pin. Existing App side runs need no record migration; future side runs use the same no-variant rule. Existing main sessions and records are unchanged.

## Migration

No stored schema migration is planned. New side questions use standard run records under a distinct trigger; clients do not reopen old side-question sessions. The App keeps its existing dock behavior and switches its launch/cancel/result path to the shared Harness service. If the agreed retention policy differs from standard run-record retention, revise this proposal before implementation.

## Checks

- Unit tests for context schema validation, deterministic bounds/order, cross-conversation isolation, omitted fields, prompt-injection boundaries, the attributed instruction descriptor, restricted resource loading, frozen no-tool capabilities and run pinning.
- Lifecycle tests for streaming, replacement, cancellation and dismissal without changing the parent run or transcript; follow-up state must clear on request and process/session exit.
- Harness `npm run typecheck`, `npm test`, `npm run prove` (server/CLI changes), and `python3 scripts/verify-terminal.py`.
- App `npm run typecheck`, `npm test`, `npm run check:layers`, `npm run check:ui`, and `cd src-tauri && cargo test`; verify the App and terminal surfaces.
- Fake-provider tests are the default. Any real-model/cache or live UI acceptance run requires the account owner's permission.
