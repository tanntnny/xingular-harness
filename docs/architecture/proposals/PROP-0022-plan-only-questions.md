---
id: PROP-0022
title: Keep question tools available only in interactive plan mode
status: Implemented
created: 2026-10-24
updated: 2026-10-24
affects: [INV-RUN-8, 02-sessions-and-runs.md, 04-prompt.md, 06-plugins-and-capabilities.md, 07-tools-and-gate.md, 11-terminal.md, 14-surfaces-and-parity.md, docs/parity.md]
---

# PROP-0022: Keep question tools available only in interactive plan mode

## Problem

The user wants ordinary chat not to expose a model-initiated question tool, while plan mode retains
questions, with no setting or plugin toggle. Today `Sessions.start` requests `ask_user` whenever
Harness tools are enabled (`src/sessions/sessions.ts`), and the terminal bridge registers both
`ask_user` and `ask_user_question` (`src/terminal/piExtension.ts`). Plan mode currently retains the
same SDK tool list (`src/sessions/planMode.ts`) and filters the terminal's active list from its
current tools (`src/terminal/tui/runtime.ts`).

`ask-user` is a required built-in plugin (`src/plugins/builtin.ts`); it has no switchable attachment,
and `plugins.attach` rejects required plugins (`src/plugins/api.ts`). `harnessTools: false` is too
broad: it also omits History, Wiki, skill loading, checklist, and session naming. A mode-aware tool
policy is needed instead of disabling the plugin.

## Affected rules

- **INV-RUN-8:** “Plan mode never changes the tool list or the system prompt, so switching it keeps
  the cached prefix. Its refusals happen before approvals and no approval can lift them.” This
  proposal changes the tool-list part: an attended plan request may expose the question tools that
  ordinary runs omit. Plan refusals remain before approvals. The stable system prompt remains
  unchanged; provider cache effects of the tool-list difference are not assumed.

## Proposal

1. New, ordinary interactive runs do not expose the Harness-owned `ask_user` tool. This is enforced
   while the Harness resolves the run's callable tools, before the capability set is frozen, so a
   caller cannot restore it by adding its name to `tools.allow` or a wider requested capability set.
2. An attended `plan: true` run may expose `ask_user`. Explicitly narrower caller capabilities
   still win. Automatic, probe, improver, and reflection runs do not receive a question tool.
3. In the Harness terminal, ordinary mode does not activate `ask_user` or its terminal-specific
   `ask_user_question` counterpart. A plan request may temporarily activate both from the registered
   tool inventory; the normal active-tool set is restored when planning succeeds, fails, or is interrupted.
4. Keep the `ask-user` built-in required and non-switchable. Do not add an attachment, preference,
   or per-run UI toggle. Approval prompts for gated actions remain available in normal mode; this
   proposal only removes model-initiated question forms. A model can still state an assumption or
   ask in ordinary reply text.
5. Preserve the existing run capability pinning contract. A continuation keeps its earlier frozen
   capability set, even when that set contains a question tool; suppression applies to newly resolved
   ordinary runs. If that snapshot includes `ask_user`, an automatic or probe/improver/reflection
   continuation is rejected with `continuation_mismatch` rather than narrowing the snapshot or
   allowing an unattended question. Update `INV-RUN-8` to document the plan-mode tool-list exception
   and update the session and terminal contracts plus the parity register.

This proposal concerns Harness-owned question tools. It does not blacklist arbitrary third-party
extensions that independently implement a question interface under another tool name.

## Alternatives

- **Make `ask-user` switchable and default it off.** This would remove it in plan mode too unless
  mode-specific overrides were added, and would contradict the requested fixed behavior. Making a
  required Harness part optional also changes the plugin contract and `INV-PLG-9`.
- **Set `harnessTools: false`.** This hides unrelated Harness tools and is not a question-only
  control.
- **Leave the tool visible but refuse calls outside plan mode.** The model would still see and may
  call the tool in normal mode, receiving a refusal rather than having no question surface.
- **Do nothing.** Preserves current behavior, which does not meet the request.

## Consequences

- Newly resolved normal runs have a narrower frozen tool set. Attended plan runs may include
  `ask_user` subject to their caller's capability set; this is the explicit exception to
  `INV-RUN-8`.
- The terminal derives plan-safe tools from registered tools as well as its normal active-tool list,
  then restores the ordinary list on success, failure or interruption.
- Tool-list changes may affect provider request caching. No cache-preservation claim is made; any
  real-provider measurement follows `INV-PRM-8` and requires the account owner's permission.
- Existing stored runs and plugin attachments need no migration. Continuations retain the earlier
  pinned tool set as required by `INV-RUN-2`.
- Gated tool approvals and plain-text questions remain possible. The guarantee is specifically
  that the Harness-owned question tools are not callable in newly started normal runs.

## Migration

No protocol, storage schema, or attachment migration is required. New runs resolve the mode-specific
callable set before `freezeRun`; existing run records and their capability snapshots are unchanged.
Continuations preserve their original snapshot. The App needs no separate preference or UI; it
continues to call Harness, which enforces the selection. Its sidecar tests must verify the resulting
tool set.

## Checks

- SDK session tests prove normal runs omit `ask_user` even when requested, attended plan runs can
  include it, narrower capability sets still exclude it, automatic/refinement/reflection runs do not
  receive it, and continuation snapshots remain exact.
- Terminal tests prove normal active tools omit both question names, plan mode activates them, and
  the normal set is restored after success, failure and interruption.
- Run Harness `npm run typecheck`, `npm test`, `npm run prove`, and the terminal question/plan
  verification. After Harness implementation, run the App's typecheck, tests, layer check, and Rust
  tests, including sidecar coverage of normal and plan tool lists.
- Use fake-provider tests by default. Any real provider cache check requires the account owner's
  explicit permission.
