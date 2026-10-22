---
id: PROP-0003
title: Name the model and account of refinement's executions on refine.start
status: Implemented
created: 2026-10-21
updated: 2026-10-21
affects: [05-refinement.md, 10-server-protocol.md, 01-extension-points.md (RefineHost)]
---

# PROP-0003: Name the model and account of refinement's executions on refine.start

## Problem

`refine.start` lets a caller choose the model, effort and account of the improver, selector and
reflector sessions (`improver: ImproverSettings`). It does not let the caller choose them for the
executions (base, candidates, finals):

- `PiExecutor.execute` (`src/refine/pi.ts`) takes `model`, `effort`, `accountId` and `poolId` only
  from `RefineHost.session(...)`.
- With no host (a plain `xharness serve`, which Evaluation drives), `DEFAULT_REFINE_HOST`
  returns none of them. The executions then run on whatever Pi resolves as the default account's
  default model.
- Runs do not consult saved per-mode choices either (`accounts.choices` is terminal-only).

So a server client cannot say "execute with `openai-codex/gpt-6-luna` on account X". Evaluation
cannot meet its own rule ("Live runs require an explicitly selected credential, model, and bounded
configuration. Do not silently substitute models or accounts"), and a measured run could silently
use a different executor model from the one recorded in its config.

## Affected rules

- 05 Contracts: "`start({ task: { id, scope, prompt, ... }, k?, mode?, baseVersion?, improver?, retainWorkspaces? })`".
- 01 Extension points, `RefineHost.session` supplies the rollout's session settings. This stays
  true; the proposal only adds a caller-supplied default beneath it.
- 10 Server protocol: the `refine.start` parameters.

## Proposal

**05 Contracts:**

- `start` gains `executor?: { model?, effort?, accountId?, poolId? }`, with the same shape as
  `ImproverSettings`.
- For each execution, the settings come from the host's `session(...)` value first, then from
  `executor`, then from the account default.
  - A host keeps full control.
  - A caller with no host can still pin the model.
- `summary.json` records `settings: { executor, improver }` as the refinement was started. Each
  probe run's own record holds the model it resolved, so the run records stay authoritative.

**10 Server protocol:** `refine.start` accepts `executor`, and `refine run` accepts
`--executor-model <id>`. The existing `--model` keeps meaning the improver model. Its usage text
says so.

No application concept is named. The default behaviour, with no `executor`, is unchanged.

## Alternatives

- **Do nothing; set Pi's default model in the account's agent folder.** This relies on Pi's
  settings file layout, which is an internal of the account folder, and it is not recorded with
  the refinement. Rejected.
- **A `refine.host` RPC so a client can describe a host.** This is far larger: callbacks over the
  protocol for `prepareWorkspace` and `deliverable`. The only need today is the session settings.
- **Reuse `improver` for executions.** The paper separates executor and editor models (GLM-5 or
  Gemini executors, an Opus editor). Conflating them would make that design impossible to express.

## Consequences

- **Applications:** none. The App supplies a host, and the host's values still win.
- **Stored data:** one optional object in `summary.json`.
- **Protocol:** one optional parameter, which is additive.

## Migration

None. Old summaries have no `executor` field.

## Checks

- A unit test: with no host, a refinement started with `executor.model` runs every probe with
  that model. With a host that names a model, the host's model wins.
- `npm run typecheck`, `npm test`, `npm run prove`.
- App: `npm run typecheck`, `npm test`, `npm run check:layers`, and `cd src-tauri && cargo test`.
