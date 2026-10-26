---
id: PROP-0040
title: One launch path and command contract across front ends
status: Accepted
created: 2026-11-19
updated: 2026-11-19
affects: [INV-EXT-1, INV-RUN-1, INV-VAR-4, INV-PLG-11, INV-PAR-1, INV-PAR-2, INV-STO-3, 01-extension-points.md, 02-sessions-and-runs.md, 03-variants.md, 04-prompt.md, 06-plugins-and-capabilities.md, 07-tools-and-gate.md, 10-server-protocol.md, 11-terminal.md, 12-storage.md, 13-world-tools.md, 14-surfaces-and-parity.md]
---

# PROP-0040: One launch path and command contract across front ends

## Problem

The approved App parity and Solo tabs handoff implemented a shared command registry and standard
prompt sections, but the actual terminal still loads Pi command built-ins, terminal run records
omit variant pins, session operations differ across front ends, and native browser schemas differ.
Matching data roots alone does not share credentials: the terminal defaults to a file SecretStore
while a host may supply its Keychain. Existing compiler-only tests do not establish runtime parity.

## Affected rules

- INV-PAR-1: every capability a person uses in a host is a Harness capability with a terminal surface.
- INV-PAR-2: both surfaces must pass acceptance before a capability is complete.
- INV-RUN-1 and INV-VAR-4: runs retain account, variant and capability pins.
- INV-EXT-1: extension-point changes require a proposal; native backends remain tool providers.
- INV-STO-3: storage layout changes are explicit and owned by one Harness module.
- INV-PLG-11: plugin categories remain internal; surface availability is optional metadata, not a category.

## Proposal

The owner approved “Complete App parity and Solo tabs”, including one shared interactive default,
on 2026-11-19. This proposal records that design; implementation status is tracked separately.

1. Core commands are browser-safe data in `commands/registry.ts`. `commands.list` resolves the
   effective scope's trusted plugin commands, prompts and skills with identical namespace and
   collision rules. A menu entry alone does not prove command acceptance.
2. Saved-history controls cover tree, navigate, fork, clone, rename, last reply and JSONL export.
   Commands requiring a live session use `SessionRunInput.command`: compact, summarized navigation
   and HTML export. They retain normal run lifecycle, busy fencing, cancellation and pins.
3. `Launch.standard` supplies shared role, working-folder and connection wording. Tool and prompt
   differences must be attributable to declared add-ons or explicit caller policy, not a front end.
4. Interactive defaults are Harness-owned: data root, state directory, neutral default variant
   scope and credential backend. Explicit roots/scopes and existing session/continuation pins win.
   No App-specific discovery, automatic root merge, account substitution, credential downgrade or
   OAuth-store copying is permitted. Adoption of conflicting populated profiles is explicit.
5. Both surfaces load Harness-trusted resources and first-party hooks. Terminal-only Pi built-ins
   and `ask_user_question` are removed; attended plan mode uses `ask_user`.
6. Browser contracts are backend-neutral and owned by Harness; the isolated and native host
   backends share names, schemas, safety metadata and ref freshness. A backend must report an
   unsupported operation honestly, never reinterpret a snapshot ref as a selector.
7. `get_capabilities` is a read-only Harness tool bound to the current run's frozen callable set
   and actual registered schemas. Discovery never grants permission or accepts caller identity.
8. Optional `PluginDescriptor.surfaces` / `Plugin.surfaces` metadata is
   `{ preferred: 'host', terminal: 'fallback' | 'unavailable', note }`. Generic host-backed
   capabilities retain Harness ownership; inspection shows fallback/unavailable reasons.
9. Shared session references/catalog registration belong to Harness. Existing host transcript
   presentation remains host-owned; native entry identities, not positional message counts,
   connect navigation and fork to that presentation.

## Alternatives

- Do nothing: leaves command names that only approximate the advertised capabilities.
- Match roots manually: rejected by the owner's explicit choice of one shared default.
- Put browser contracts or session orchestration in the host: violates INV-PAR-1.
- Merge existing stores automatically: unsafe for account pins, credentials and conflicting variants.

## Consequences

Server methods and SDK fields are additive. Existing session histories and account IDs remain valid.
Terminal run records gain variant identity. Host browser adapters implement the common contract;
legacy native routes may remain non-model-visible compatibility aliases for one release. Metadata
labels do not certify acceptance or waive the gate.

## Migration

Keep explicit custom roots and historical pins. Seed only an absent default scope through validated
variant APIs. Shared profile adoption must preserve originals, report conflicts/failure, and never
silently select an empty replacement. Credentials remain in their owning backend. Shared processes
must coordinate credential refresh and respect live run owners. Development/disposable profiles
remain isolated from production. No migration is exercised on owner data during implementation.

## Checks

Harness typecheck, full tests and prove; deterministic terminal verification; App renderer/sidecar,
layer/UI and Rust checks; full browser fixtures; shared UI and both consuming applications' checks.
Runtime parity compares actual prepared launches, tool schemas and recorded pins. Native WebKit
acceptance uses an isolated profile. Real-provider/cache checks require separate owner permission.
