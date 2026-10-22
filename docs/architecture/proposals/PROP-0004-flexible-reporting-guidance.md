---
id: PROP-0004
title: Flexible final-reply guidance with an optional human-inspection heading
status: Implemented
created: 2026-10-21
updated: 2026-10-21
affects: [INV-PRM-2, 04-prompt.md, ADR-0007, ADR-0008]
---

# PROP-0004: Flexible final-reply guidance with an optional human-inspection heading

Accepted by the user and implemented; see [ADR-0008](../../decisions/ADR-0008-flexible-reporting-guidance.md).

## Problem

The stable `reporting` section in `src/prompt/compile.ts` prescribes a fixed sequence of headings,
including **Worth a look** and **Check by hand**. This can force generic report structure when it adds
no value, and “Worth a look” does not clearly distinguish a concrete action that needs human
inspection because the agent could not perform it. The user requests flexible, content-driven
headings and a clearer label for genuinely unverified work.

## Affected rules

- `04-prompt.md`, Reporting: “It is fixed text that shapes the final reply” and currently specifies
the ordered parts Files, Blocked, Worth a look, Check by hand, and Next steps.
- **INV-PRM-2**: “The system prompt holds only stable text: identity, role, the tree's sections, the
harness's reporting guidance, tool guidance and the tool manifest. Changing state never enters it.”
  The invariant remains unchanged; the reporting text remains stable.
- [ADR-0007](../../decisions/ADR-0007-reporting-section.md) records the prior fixed heading list;
it is superseded by [ADR-0008](../../decisions/ADR-0008-flexible-reporting-guidance.md).

## Proposal

Keep the harness-owned reporting section, its position, stable delivery, and concise outcome-first
rule. Replace the mandatory fixed heading sequence with guidance to use only structure that helps
explain the outcome; do not require generic headings such as **Worth a look** or **Check by hand**.

When a concrete verification step requires a person because the agent could not perform or observe
it, use the optional heading **Need human inspection**. Say what remains unverified, why the agent
could not verify it, and the specific check the person should perform. Do not use this heading for
checks the agent ran or for speculative, non-actionable risks. Continue to report checks truthfully
and honor any format requested by the person, application, or current mode.

## Alternatives

- **Do nothing.** Keep the fixed headings, even when they produce generic or misleading sections.
- **Remove all guidance about unverified work.** This avoids a fixed heading but makes it easier to
  omit concrete human follow-up.
- **Make “Need human inspection” mandatory.** Rejected because many tasks have no check requiring a
  person.

## Consequences

- The system prompt stays stable and harness-owned; all applications receive the revised guidance.
- Existing sessions get one provider-prefix change and may miss the prompt cache once after upgrade.
- No stored data or server protocol changes. Applications bundling the harness must rebuild to pick
  up the new guidance.

## Migration

None for stored data. The new text supersedes the reporting instructions in ADR-0007; reverting the
change would alter the stable prefix again.

## Checks

- `src/prompt/compile.test.ts`: assert the stable system prompt carries the flexible guidance,
  does not require the old fixed headings, and describes **Need human inspection** as conditional.
- Harness `npm run typecheck` and `npm test`.
- Xingular Agent `npm run typecheck`, `npm test`, `npm run check:layers`, and `cd src-tauri && cargo test`.
- Provider-cache impact is measured only with real application requests and the account owner's
  permission, as required by INV-PRM-8.
