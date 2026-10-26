---
id: PROP-0034
title: Conversation-scoped provider fast mode
status: Proposed
created: 2026-10-25
updated: 2026-10-25
affects: [INV-RUN-1, INV-RUN-3, INV-PAR-1, INV-PAR-2, 02-sessions-and-runs.md, 09-accounts-and-connectors.md, 10-server-protocol.md, 11-terminal.md, 12-storage.md, 14-surfaces-and-parity.md, parity, App thread runtime settings]
---

# PROP-0034: Conversation-scoped provider fast mode

## Problem

People cannot request a provider's native priority/fast service for a conversation without changing
models or reasoning effort. Adding a UI-only flag would not reach Pi's provider request, and
forwarding an unchecked option would send unsupported fields to APIs that do not implement it.
The terminal and App must agree on the setting, restore it with the conversation, and explain when
the selected provider/API/model cannot honor it.

Evidence: Pi 1.2.0 exposes `serviceTier` for OpenAI Responses and Codex Responses requests. The
Anthropic SDK exposes `speed: 'fast'` for beta Messages; Anthropic documents the eligible Claude
models and the preview beta requirement at
https://platform.claude.com/docs/en/build-with-claude/fast-mode. The existing Harness terminal has
a persistent Pi history branch, while the App stores `ThreadRuntimeSettings` with each conversation
and passes `SessionRunInput` through its sidecar.

## Affected rules

- **INV-RUN-1** currently says: “A run pins one account, one variant version and one capability set
  when it starts. None of them changes during the run.” The selected service tier must also be fixed
  for the whole run; it must not alter the model or effort.
- **INV-RUN-3** currently says: “Every run event is validated against its schema, redacted,
  persisted, and only then relayed to listeners, in order.” A provider rejection that disables fast
  mode needs a validated event so both surfaces can persist the conversation setting as off.
- **INV-PAR-1** requires every host capability to be a Harness capability surfaced by the terminal.
- **INV-PAR-2** requires both terminal and host surfaces to pass acceptance for a capability.

## Proposal

Add an optional `fastMode` boolean to `SessionRunInput`, defaulting to `false`. A run captures this
value at start and uses the same value for all model requests in that run. The option changes only a
provider-native request parameter; it never changes the selected model, reasoning effort, prompt, or
tool set. Fast mode is an attended conversation setting; automated, refinement, reflection,
subagent, and side-question runs do not inherit it implicitly.

Use a conservative, explicit provider capability map based on the resolved model's provider, API,
model id, and endpoint:

- OpenAI Responses and Codex Responses use their native `service_tier: 'fast'` option.
- Eligible Anthropic Messages models use `speed: 'fast'`; preview models also receive the required
  fast-mode beta header, composed with any existing headers and Pi payload hooks.
- Only documented model/API combinations on verified official endpoints are supported. Unknown
  APIs, custom endpoints, proxies and other providers are unsupported until verified. The model
  capability response reports both support and a short reason when unavailable.

Unsupported combinations never receive a fast request. Attempting to enable the setting leaves it
off and explains why. Selecting an unsupported model while fast mode is on turns the setting off
with an explanation. If a provider explicitly rejects the fast/priority option after a supported
request was sent, do not retry at standard priority: surface the provider error, emit a validated
`fast_mode.disabled` run event, and disable fast mode for later requests in that conversation.

Persist the conversation setting at the owning surface:

- The terminal writes an invisible custom entry to Pi's native history branch. New sessions start
  off; resumed sessions and branch navigation restore the last setting on that branch. A failed
  fast request appends the off state to the branch.
- The App adds `fastMode` to its existing per-thread `ThreadRuntimeSettings` and passes it with each
  run. Missing values in older thread files mean off. The App handles `fast_mode.disabled` by
  saving the setting as off.

Expose `/fast`, `/fast on`, and `/fast off` in the terminal and App composer. The App also offers a
Fast on/off row in the existing thread Account/Model/Effort settings popover. The terminal status
line shows a shimmering `⚡ fast` immediately after effort when enabled. Both surfaces explain that
fast mode may cost more and does not guarantee lower latency. New conversations default off; resume
restores the existing conversation setting.

The account model capability response gains `fastModeSupported` and an optional explanatory reason
so the App can disable the setting before a request. No new Harness storage directory or run-record
file is added; the terminal setting uses native Pi history, the App setting uses its existing thread
record, and the rejection event uses the existing run event store.

## Alternatives

- **Do nothing.** This avoids a new provider option but leaves no supported way to request native
  priority.
- **Change model or effort to imply fast mode.** Rejected: those are independent user choices and
  would not select the provider's priority service.
- **Forward a generic priority field to every provider or proxy.** Rejected: support and semantics
  are API-specific, and an unknown endpoint must not receive an unverified option.
- **Retry at standard priority after rejection.** Rejected: this hides the provider's error and
  changes the requested service without consent.
- **Keep the setting only in the App.** Rejected by INV-PAR-1/2: the terminal must offer the same
  conversation capability.

## Consequences

`SessionRunInput`, the model-capability response, and the run-event schema change. The terminal,
App sidecar, App thread settings UI, and both surfaces' command handling change. No prompt compiler,
model-selection, effort-selection, or tool-gate behavior changes. Because fast mode can cost more,
the UI must disclose that; no latency improvement is promised. A provider error remains visible and
is not hidden by a normal-priority retry.

## Migration

No native-history or App thread migration is required. A missing terminal custom entry and a missing
App `fastMode` field both mean off. Existing provider and run-event readers remain compatible with
old records; the App's run-event schema must be updated before it consumes the new event. Resuming a
conversation restores its setting; starting a separate conversation defaults off.

## Checks

- Unit tests for provider/API/model/endpoint support and native request-option composition, including
  preserving Anthropic reasoning-summary hooks and headers.
- Harness tests for preflight rejection, per-run stability, provider rejection without standard-tier
  retry, validated disable events, and terminal setting persistence across resume/fork/navigation.
- App tests for legacy thread defaults, persistence, capability gating, `/fast`, the settings row,
  and handling `fast_mode.disabled`.
- Run Harness `npm run typecheck`, `npm test`, and `npm run prove`; App `npm run typecheck`,
  `npm test`, `npm run check:layers`, and `cd src-tauri && cargo test`; exercise the terminal status
  line in a local PTY. Do not make live-provider requests as part of these checks.
