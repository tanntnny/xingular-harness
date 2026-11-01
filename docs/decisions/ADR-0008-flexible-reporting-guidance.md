---
id: ADR-0008
title: Flexible reporting guidance with optional human inspection
status: accepted
created: 2026-10-21
updated: 2026-10-21
supersedes: ADR-0007
amended_by: ADR-0073, ADR-0074
---
# ADR-0008 — Flexible reporting guidance with optional human inspection

> **Amended by [ADR-0073](ADR-0073-large-reporting-prompt.md):** flexible headings stand; the `reporting` section now names required content blocks and ships worked examples, and the later fixed headings (ADR-0068) are gone. **Amended again by [ADR-0074](ADR-0074-report-content-not-report-blocks.md):** the required blocks are gone too, and human inspection is once more the only optional by-hand block.

## Context and decision

ADR-0007 added stable, harness-owned guidance for final replies, but its fixed heading list could
produce generic sections and did not clearly identify when a person must perform a check the agent
could not perform or observe. The user accepted [PROP-0004](../architecture/proposals/PROP-0004-flexible-reporting-guidance.md).

Keep the `reporting` section in the stable system prompt and lead with the outcome, but do not
require a fixed set of headings. Use only structure that helps explain the work. **Need human
inspection** is an optional heading for a concrete verification that requires a person because the
agent could not perform or observe it; state what remains unverified, why, and the specific check
to make. Do not use it for checks already performed or generic risks. Report only checks actually
run and their results.

## Consequences

- Every session receives the same concise, flexible reporting guidance.
- The stable prefix changes once; existing sessions may miss the provider cache once after upgrade.
- No stored data or server protocol changes. Applications bundling the harness need a rebuild to
  receive the updated prompt.
- Cache behavior is measured only with real application requests and the account owner's
  permission, as required by INV-PRM-8.

## Alternatives considered

- Keep the fixed headings: rejected because they can add generic structure and mislabel follow-up.
- Remove all guidance about unverified work: rejected because concrete human checks could be omitted.
- Make **Need human inspection** mandatory: rejected because most tasks do not require a person to
  perform a check.
