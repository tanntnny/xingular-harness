---
id: PROP-0019
title: Harness-owned contextual side questions across surfaces
status: Implemented
created: 2026-10-24
updated: 2026-10-24
affects: [INV-RUN-1, INV-RUN-3, INV-RUN-5, INV-GATE-1, INV-PLG-1, INV-PLG-5, INV-CAP-1, INV-SRV-1, INV-SRV-2, INV-PAR-1, INV-PAR-2, 02-sessions-and-runs.md, 06-plugins-and-capabilities.md, 07-tools-and-the-gate.md, 10-server-protocol.md, 11-terminal.md, 14-surfaces-and-parity.md, 12-storage.md, ADR-0023-contextual-side-question-runs.md]
---

# PROP-0019: Harness-owned contextual side questions across surfaces

## Problem

`/btw` currently has two different execution paths. The terminal constructs a direct, in-memory Pi
session in `src/terminal/tui/sideQuestion.ts`; it supplies at most six visible turns and 6,000
characters, names of tools called, but no tool inputs or results. It has no Harness run record. The
App assembles a different bounded snapshot and starts a separate, tracked `sessions.run` with
trigger `side-question` (`App/docs/features/FEAT-0014-side-questions.md`). The parity register calls
these one capability but lists no Harness owner method (`docs/parity.md`).

The terminal side model therefore answers from a short excerpt, lacks the main run's instructions
and evidence, and is explicitly told to be brief. The two surfaces also have different observability
and lifecycle. A question about work outside the repository can be answered incorrectly when that
work is absent from the excerpt, even if the main run already read it.

## Affected rules

- **INV-RUN-1:** A side question pins its selected account and an empty capability set, with no
  variant (`variantVersion: null`), because it uses only fixed Harness instructions and a redacted
  projection supplied by or read from the main run.
- **INV-RUN-3:** Parent run events used as context have already been validated, redacted and
  persisted. Side-question events use the same contract.
- **INV-RUN-5:** Side questions use a dedicated unattended launch: no extensions, context files,
  variant code, connectors, providers, subagents, or Harness tools.
- **INV-GATE-1:** A side-question run has no tools to call; this is enforced by the Harness.
- **INV-PLG-1 / INV-PLG-5:** The Harness remains the only loader. Its fixed side-question
  instruction is attributed to a Harness-owned plugin descriptor.
- **INV-CAP-1:** The side run freezes an empty tool, connector, and contribution set.
- **INV-SRV-1/2:** Hosts call an additive Harness service through the server contract and the same
  in-process API.
- **INV-PAR-1/2:** The Harness owns the capability; terminal and host surfaces use it.

## Proposal

1. Add a generic Harness side-question service with start, read and interrupt operations. It is
   callable by the standalone terminal and embedding hosts. Each question is an independent
   run with a new native history identity, ordinary run records, event validation and redaction.
   It is not a child, subagent, continuation, queued message, or change to the main run.
2. The service builds a bounded context from the main run's recorded effective system prompt,
   current context update, visible tool inventory, persisted public run events, and a caller-supplied
   transcript projection. Visible context includes assistant text, tool names, inputs and results.
   Hidden reasoning and attachment bytes are excluded. Credential-like fields and common secret
   forms are redacted before context enters the side run. Conversation and tool contents are framed
   as evidence; they cannot expand the side run's authority. Context limits are fixed in code and
   tested, keeping the effective prompt first and the newest conversation/activity when trimming.
3. A side-question run uses the main conversation's selected account, model and effort, with an
   independent session identity and a fixed, attributed Harness instruction. It records no variant
   (`variantVersion: null`) and freezes an empty capability set. It loads no tools, providers,
   connectors, subagents, project context files, user or variant plugin code, or main native history.
   The main system prompt is context for answering, not permission to access the main run's tools.
4. A side question and answer never enter, steer, stop or queue work on the parent conversation.
   They are recorded only in the independent side run's ordinary events; clients may show that run
   in Trajectory and Usage. No separate durable side-thread store is introduced.
5. Each surface keeps its current side-question presentation. The terminal supports a scrollable
   answer, copy and dismissal. The App continues to own its dock and conversation selection, while
   the Harness owns launch policy, context construction, run lifecycle and result events.
6. Phase two aligns the host path policy with the main read path: absolute and `~` paths are
   available to read-only file tools anywhere the operating system permits. The working directory
   is a default location, not a repository sandbox. Edit, write and command calls continue through
   the existing gate.
7. Update the capability register so the Harness service owns side questions and both terminal and
   App surfaces call the shared contract.

## Alternatives

- **Keep the terminal-only Pi session and raise its excerpt limits.** This leaves the App and
  terminal with different semantics and observability.
- **Send hidden reasoning, attachment bytes, or the entire native history.** This exposes material
  that is not needed to answer questions and can include private or provider-internal content.
- **Give the side question the main run's tools.** This turns a side answer into independent work
  with authority and can cause effects that the user did not request.
- **Persist all side-question threads in a new store.** This adds retention, deletion and
  cross-surface synchronization contracts; ordinary run records already capture model usage and
  results.
- **Treat the repository root as a read boundary.** Pi's read-only file tools accept absolute and
  `~` paths, but the App's host policy also applies a working-folder/trusted-folder check. The
  approved implementation removes that extra read restriction and accepts `~` in host path checks;
  writes and commands keep their existing gates.

## Consequences

- Side-question requests and answers become ordinary, separately inspectable Harness run records.
  They remain absent from the parent transcript and are no longer ephemeral from the run store.
- The Harness owns the context schema, redaction, bounds, restricted launch and lifecycle. Hosts
  provide only the transcript projection they own and present the Harness result.
- A dedicated restricted launch and an attributed first-party instruction are required. The
  restriction is explicit; `automatic: true` alone is not the contract because unattended runs have
  their own plugin loading rules.
- No data migration or protocol version change is required. New side runs use the
  `side-question` trigger and no variant pin. A supplied parent run must belong to the supplied
  parent session; the terminal and App derive that relationship from their active conversation.
- The Harness file-reading behavior does not change. The App now aligns its host gate with that
  OS-permission boundary for read-only native file tools. Its existing approval and scope gates
  remain in place for writes and commands.

## Migration

No stored schema migration is planned. New side questions use standard run records under a distinct
trigger; clients do not reopen old side-question sessions. The App switches its launch path to the
shared Harness service and permits OS-readable paths in read-only native file tools. Existing run
records and write/command gates are unchanged.

## Checks

- Unit tests for context redaction, ordering, bounds, omitted hidden fields, parent event projection,
  attributed instructions, no-tool launch, run pinning and owner-scoped reads/interrupts.
- Lifecycle checks for streaming, replacement, cancellation and dismissal without changing the
  parent run or transcript.
- Harness `npm run typecheck`, `npm test`, `npm run prove`, and `python3 scripts/verify-terminal.py`.
- App `npm run typecheck`, `npm test`, `npm run check:layers`, and `cd src-tauri && cargo test`.
- Fake-provider tests are the default. Any real-model/cache or live UI acceptance run requires the
  account owner's permission.
