---
id: PROP-0027
title: Use Xingular Agent as the default Harness product identity
status: Accepted
created: 2026-10-24
updated: 2026-10-24
affects: [INV-BND-2, 00-overview.md, 04-prompt.md, 11-terminal.md, terminal-tui.md, ADR-0028]
---

# PROP-0027: Use Xingular Agent as the default Harness product identity

The product owner accepted this proposal on 2026-10-24. The decision is recorded in
[ADR-0028](../../decisions/ADR-0028-xingular-agent-product-identity.md).

## Problem

The empty welcome in `src/terminal/opentui/root.tsx` derives its block mark and spaced subline from `XINGULAR_HARNESS_NAME`, which `Terminals.prepare()` sets from `env.productName`. When no product name is supplied, `src/core/env.ts` defaults to `Xingular Harness`, so the current welcome shows a large `XINGULAR` mark and `H A R N E S S` subline. The requested identity is an orange `X` mark followed by a blue `A G E N T` label, with a welcoming message and restrained `/help` hint.

`Xingular Agent` is the product name; the requested screen remains the Harness-owned terminal. However, changing the default name changes person- and model-visible Harness text beyond this screen, and the specification forbids naming an application. This required an explicit architecture decision, which the product owner accepted as PROP-0027.

## Affected rules

`INV-BND-2` currently says: “The harness names no application and no application concept (agent role, group, task, pane, handoff, App browser workspace, computer use) in code paths it reads or text a model or person sees. Text names the product through `env.productName` (default `Xingular Harness`; `{product}` in a tool description).”

The rule's default product identity and its prohibition on application naming are affected. The terminal's existing ownership and composition contracts in `11-terminal.md` are not otherwise changed.

## Proposal

Make `Xingular Agent` the default `env.productName`, while retaining explicit `productName` values supplied by embedding hosts. Amend `INV-BND-2` to allow this exact canonical product identity as the default; continue to forbid application concepts, app-specific branching and other application names in Harness behavior.

For the welcome, format a multiword product name as a block mark made from the first letter of its first word, followed by the remaining word or words letter-spaced. Thus the default `Xingular Agent` appears as an orange `X` and blue `A G E N T`. A single-word product name keeps its full word as the mark and has no subline. Keep the greeting and tagline neutral, color the `/help` hint blue, and preserve the existing model/thinking information and composer. Use the existing `theme.primary` orange and `theme.accent` blue; do not add tokens or change other terminal surfaces.

The default product name is used by Harness outside the TUI, including compiled prompt and Wiki text. This proposal intentionally changes those defaults too; embedding hosts that need another identity continue to pass their own `productName`.

## Alternatives

- **Keep `Xingular Harness` as the default and rely on `productName` overrides.** This preserves `INV-BND-2` and avoids changing prompt/Wiki text, but does not make the requested product identity the built-in default.
- **Change only the TUI welcome label.** This would show `Xingular Agent` while other Harness text still calls the product `Xingular Harness`, and would bypass the existing `env.productName` boundary.
- **Do nothing.** Retains the current `XINGULAR` / `H A R N E S S` welcome.

## Consequences

- Hosts that omit `productName` will use `Xingular Agent` in Harness-authored product text, not only in the terminal welcome. Hosts with an explicit name are unaffected.
- The terminal remains Harness-owned and generic in behavior. No application-specific branches, capabilities, storage or protocol fields are added.
- Existing session/run records and Wiki data are not rewritten. New compiled contexts and new Wiki text use the new default; prior records retain the name with which they were created.
- No server or terminal wire schema changes.

## Migration

No data migration is required. Embedding hosts that need to retain the former default can pass `productName: 'Xingular Harness'`; hosts with another product identity continue to pass that name explicitly. Reverting the default affects only newly created contexts and text, not persisted records.

## Checks

Verification:

- Test `createEnv()`'s new default and that an explicit `productName` still wins.
- Add a focused PTY welcome check for the `A G E N T` label and orange/blue ANSI colors at 40x20, 80x24 and 120x40; verify `/help` replaces the welcome.
- Run Harness `npm run typecheck`, `npm test`, `npm run prove`, `npm run build`, and the focused terminal verification.
- Run Xingular Agent's `npm run typecheck`, `npm test`, `npm run check:layers`, and `cd src-tauri && cargo test`.
- Update the affected architecture and terminal-detail pages, and record the accepted lasting choice in an ADR.
