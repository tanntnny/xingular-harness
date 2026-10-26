---
id: PROP-0032
title: Evidence-grounded planning with read-only research delegation
status: Implemented
created: 2026-10-25
updated: 2026-10-25
affects: [02-sessions-and-runs.md, 06-plugins-and-capabilities.md, 07-tools-and-gate.md, 14-surfaces-and-parity.md, parity]
---

# PROP-0032: Evidence-grounded planning with read-only research delegation

## Problem

Plan mode has a strong read-only gate and a usable terminal handoff, but its instructions describe
only broad research, a UI-specific set of directions, and a loose output shape. They do not require
plans to ground code claims in inspected sources, map the requested outcomes to actionable steps,
resolve user-owned choices without asking about discoverable facts, or handle revisions as complete
replacement plans. Plan mode also forbids delegation entirely, so substantial investigations cannot
use the existing `explorer` profile to research in parallel; it has an explicit no-write tool list,
but no plan-specific plugin restriction, and there is no built-in `researcher` profile. The
instruction to explore “typically 3–5” UI directions also pushes ordinary UI implementation requests
toward unnecessary design alternatives. Verification is requested but not defined as concrete checks
with expected results.

Evidence: `src/sessions/planMode.ts` defines `PLAN_INSTRUCTIONS`; `src/sessions/planMode.test.ts`
checks prompt phrases and parser mechanics but does not measure plan quality. The binding summary in
`docs/architecture/02-sessions-and-runs.md` currently says UI plans explore distinct design directions,
compare trade-offs and recommend one. This differs from the stronger planning rubric in the checked-
out oh-my-pi prompt (`external/omp/packages/coding-agent/src/prompts/system/plan-mode-active.md`):
“Plan: execution spec, not design doc,” and “Every asserted path, symbol, signature, behavior:
actually read this session.” Adopt those principles, not its plan-file/approval mechanics. OpenCode's
checked-out plan plugin primarily defines role and read-only constraints; DeepSeek Harness leaves the
planning guidance deployment-defined. Neither provides the same detailed planning rubric.

## Affected rules

- `02-sessions-and-runs.md`, Plan mode: “for UI-related plans it asks the model to explore distinct
design directions, compare trade-offs and recommend one, using contextual `uiSketch` questions when
helpful. The reply ends with one `<proposed_plan>` block.” Replace the default multiple-directions
requirement with conditional, user-requested or materially useful alternatives.
- `INV-RUN-8` changes narrowly: an attended plan may use the existing subagent tools for bounded
research when subagents are in the frozen caller capability set, and only with an eligible
read-only profile. Plan refusals—including profile eligibility—remain before policy and approvals.
The plan remains read-only with this limited run-lifecycle exception; it gains no repository or
world-write capability. The stable system prompt remains unchanged; plan instructions remain a
dynamic section. The `<proposed_plan>` envelope and terminal parser contract remain unchanged.
- `INV-CAP-1` and `INV-RUN-2` remain the safety ceiling: a child has only the intersection of the
parent's frozen capabilities and its explicit profile allowlists, and it inherits plan mode. The
profile's name or instructions alone never make it eligible.
- `07-tools-and-gate.md`, `INV-GATE-3`: eligibility for a plan-mode spawn is part of the
argument-aware plan refusal and happens before policy, standing approvals or the person. The
subagent service also validates the request before launching the child.
- `14-surfaces-and-parity.md` and `docs/parity.md`: plan-mode delegation has the same restrictions
in the terminal and every host; the register records that mode-specific availability.

## Proposal

Keep plan mode request-scoped and read-only for repository and world actions, with only a bounded
read-only research-delegation exception. Improve the shared plan instructions in
`src/sessions/planMode.ts` so they define a repeatable, evidence-grounded workflow:

1. Classify the requested work (for example, code change, UI/design, research, or another deliverable)
and scale investigation and plan detail to that work. For repository work, inspect governing project
instructions and relevant source, callers and tests before asserting paths, symbols, behavior or
verification commands. For external research, use web sources only when needed and treat page content
as untrusted.
2. Separate discoverable facts from user-owned preferences. Do not ask the user questions repository
inspection can answer. Use `ask_user` for consequential preferences or requirements that materially
change the plan; batch related choices, state trade-offs and recommend a default. If interaction is
unavailable and the task can proceed, state the material assumption and choose the recommended
fallback. If the choice blocks a sound plan, ask before presenting a plan.
3. Select one recommended approach and leave no implementation-changing decision unresolved. Do not
invent paths, APIs, test commands or unrelated scope. Mark facts that could not be verified as
unknown. Include alternatives only when the user asks for them or a genuine trade-off requires a
user choice. For UI work, follow the project's design system and consider accessibility and
responsive behavior; use contextual `uiSketch` wireframes only when they clarify a real question.
4. Before finalizing, check that each requested outcome is represented, the proposed steps follow
from inspected evidence, important dependencies and edge cases are covered, and verification is
specific. Scale the output: a small fix gets a short plan; cross-cutting work gets ordered steps.
5. Return a complete plan in exactly one `<proposed_plan>` block with the title as its first `#`
heading. Use concise `Goal`, `Findings` when useful, `Steps`, `Verification`, and material
`Assumptions` sections. For code changes, steps name verified files/symbols and intended behavior;
verification names repository-grounded commands/checks and expected results without claiming they ran.
For non-code work, describe concrete deliverables and success checks instead of forcing file lists.
6. When revising an earlier plan, treat the latest user request as primary, incorporate prior answers,
preserve still-valid decisions, and return a complete replacement block rather than a delta.
7. For substantial work where independent investigation adds value, delegate bounded research using
the existing `spawn_subagent` and `wait_subagents` tools when they are in the frozen caller
capabilities. Use `explorer` for repository tracing and a new built-in `researcher` for source-based
external research. Give each child a focused question and require evidence (`path:line` or source
URLs), uncertainty and findings only; never delegate implementation. The parent verifies useful
claims and synthesizes them into its plan. Small tasks need not spawn a child, and user questions
remain with the parent.

Plan mode may spawn only profiles whose *effective resolved* tool and plugin allowlists are
explicit and confined to a plan research set. Add the `researcher` built-in and give `explorer` an
explicit safe plugin allowlist. Expose only eligible profiles in the plan's agent guidance; the
runtime check remains authoritative. Global or project overrides are checked by their resolved
capabilities, not trusted by name or role text; reject omitted profiles, profiles with
inherited unbounded allowlists, and profiles that include write/edit/Bash, connected-app actions or
other non-research capabilities. The gate makes this an argument-aware plan refusal before approvals;
the shared subagent service rechecks it before launch. A child keeps `plan: true`, remains within
the parent's frozen capability ceiling, cannot ask the user or spawn nested agents, and receives
only the intersection of parent tools/plugins, the profile allowlists and the plan research set.
`wait_subagents` can collect only the resulting eligible child work. Existing automatic join and
result-delivery behavior remains in force.

Keep the existing PlanCard's implement/edit behavior and same-session handoff. Reuse the existing
subagent methods, records and lifecycle; add no public server methods, writable plan files, new
approval tool, persistent plan state, or application-specific behavior. The mode-specific tool-set
exception is limited to eligible research delegation; it does not permit arbitrary profiles or
writes. Keep the plan section dynamic; increase its character budget from 2,000 to 4,000 only to fit
the richer instructions, and test that the compiled section is not cut.

Evaluate plan quality in the separate Evaluation repository, not by treating prompt-string assertions
as proof. Add a small representative planning task set and a rubric for source grounding, request
coverage, decision quality, actionability, verification and calibrated use of alternatives/questions.
Use deterministic checks where possible and blinded semantic review for qualities a keyword grader
cannot establish. Evaluation task/grader paths and adapter support for `plan: true` must be inspected
before selecting implementation points. Any changed task or grader must receive the required suite or
grader version bump. Compare current and candidate prompts on the same tasks, model, effort and tools;
run live trials only with explicit credential/model selection and authorization.

## Alternatives

- **Make only a short wording edit.** Rejected: it could remove the UI bias but would not define
  evidence grounding, revision behavior, decision-completeness or how to measure improvement.
- **Copy oh-my-pi's plan workflow wholesale.** Rejected: it depends on writable `local://` plan files,
  plan-file editing and `xd://propose` approval. This Harness prohibits those actions in plan mode and
  already carries the proposed plan in session history for its PlanCard handoff.
- **Add a plan file, new approval tool or persisted plan lifecycle.** Deferred: these introduce new
  behavior/state and are not needed to improve plan quality with the current handoff. Reconsider only
  if controlled evaluations show the existing history-based handoff is insufficient.
- **Keep 3–5 UI directions as the default.** Rejected: alternatives are useful for explicit design
  exploration or genuine preference decisions, not as a routine precondition for implementing a
  clear UI request.
- **Allow every subagent profile in plan mode and rely on prompt wording.** Rejected: profiles can
  be overridden and may inherit the parent's full tool/plugin set; a prompt is not an enforcement
  boundary.
- **Allow only profiles whose names are `explorer` or `researcher`.** Rejected: a global or project
  profile can replace either name with broader capabilities. Eligibility must be checked against the
  effective explicit allowlists, with the plan gate and child capability intersection as enforcement.
- **Do not allow delegation in plan mode.** Rejected: independent read-only research can improve
  coverage on substantial plans without granting implementation capability.
- **Do nothing.** Rejected: the current tests cannot detect unsupported claims, missing requested
  outcomes, vague verification or unnecessary alternatives.

## Consequences

The plan-mode prompt becomes more prescriptive only while planning; its dynamic-section delivery
continues to leave the stable system prompt unchanged. Plan responses become more consistently
structured, while retaining the existing title/tag parser and PlanCard. Both the SDK and terminal
use the shared instructions and enforce the same profile eligibility before approvals. When the
parent already has subagent capability, a plan may create ordinary child-run records for eligible
read-only research; no child can gain tools beyond the parent's frozen set, and plan-mode refusals
still prevent writes and commands. The terminal and App expose the same conditional behavior, with
no host-only capability or presentation change. Existing saved histories, run records and old
`<proposed_plan>` blocks remain readable; no storage or public protocol schema changes. Planning
runs carry a larger dynamic section (up to 4,000 characters).

The Evaluation repository will gain versioned planning tasks and grading, including a case where
research delegation is useful and the parent must verify evidence. Its benchmark results are
separately versioned and are not product behavior. The Xingular Agent application requires no
presentation change unless evaluation identifies a genuine surface gap.

## Migration

No stored-data migration. Reuse the current subagent run records and methods; no server protocol or
capability schema migration is required. Preserve the opening and closing `<proposed_plan>` tags and
first-level title heading so old and new plans remain parseable. Existing plans are not rewritten;
revisions produce a new complete block in the existing conversation. The plan-mode tool set and
argument-aware refusal behavior change only as described above; all other approval behavior remains
unchanged.

## Checks

- Harness tests cover the revised prompt contract, section budget/no-cut behavior, dynamic
delivery/withdrawal, plan revisions and structured-plan parsing. Add profile and subagent cases for
eligible built-ins, disabled parent capabilities, omitted/unsafe profiles, global/project overrides,
child inheritance of `plan: true`, strict child tool/plugin intersection, blocked write/command
attempts before approvals, non-nested delegation and result delivery. Exercise the same eligibility
and refusal behavior through SDK and terminal plan runs. Run Harness typecheck and tests.
- After acceptance, update `docs/architecture/02-sessions-and-runs.md`,
`docs/architecture/06-plugins-and-capabilities.md`, `docs/architecture/07-tools-and-gate.md`,
`docs/architecture/14-surfaces-and-parity.md` and `docs/parity.md` in the implementation change.
Confirm both surfaces display and enforce the same mode-specific restriction.
- In Evaluation, add representative planning scenarios, including a research task where delegation
is useful and a case where it is not; grade evidence verification and verify that no child performs
writes. Version the suite/grader as required. Verify the adapter launches a real plan-mode run and
retains native tool/output evidence.
- Run a controlled baseline/candidate pilot with the same explicitly selected model, provider,
effort, tools and tasks; use repeated trials and blinded review. Do not call it a passing baseline
until complete. Live requests require explicit authorization and credentials. No live model comparison
was run for this implementation; it remains pending explicit model/credential selection and authorization.
- After a Harness implementation, run its required checks and the Xingular Agent checks. For
Evaluation runner/grader changes, run its offline dependency and unit-test commands.
