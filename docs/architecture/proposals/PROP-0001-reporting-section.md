---
id: PROP-0001
title: A built-in Reporting section that shapes the final reply
status: Implemented
created: 2026-10-21
updated: 2026-10-21
affects: [INV-PRM-2, 04-prompt.md]
---

# PROP-0001: A built-in Reporting section that shapes the final reply

Accepted by the user on 2026-10-21 and implemented the same day; see
[ADR-0007](../../decisions/ADR-0007-reporting-section.md).

## Problem

Nothing in the compiled prompt says how a run should end. `src/prompt/compile.ts` emits the tree's
sections, references, the Wiki pointer and the tools; a seed tree's `systemprompt.md` is empty
unless the application gives instructions (`src/tree/seed.ts`). Final replies therefore vary in
shape: the answer is often buried after a narration of steps, files changed are not listed, and
unverified work is not called out.

The person wants every final reply to answer first, list files read and changed, and say what is
blocked, what is worth a look, what to check by hand, and what comes next, using Markdown tables
where they help. The terminal already renders Markdown with tables (`docs/terminal-tui.md`,
"Markdown transcript"), so the gap is only in the prompt.

Other harnesses put this in their fixed prompt text:

| Harness | Where | What it says |
|---|---|---|
| opencode | `external/opencode/packages/core/src/plugin/system-prompt/gpt.txt:19-23` | "Final Answer": lead with the outcome; only as much structure as needed; the final answer is self-contained; a blocking question goes there |
| omp | `external/omp/packages/coding-agent/src/prompts/system/system-prompt.md:11-27, 249-257` | Numbers to compare → Markdown table; report only exercised verification; when blocked, state exactly what is missing and what was tried |
| kimi-cli | `external/kimi-cli/src/kimi_cli/agents/default/system.md:152-159` | Concise; never more than the user wants |
| Claude Code | published prompt (no clone) | Outcome first, tl;dr style; report failed or skipped checks; `path:line` references |
| Codex CLI | published prompt (no clone) | "Final answer structure": headers only when useful, bullets, file paths, a natural next step |

## Affected rules

- `04-prompt.md`, Section order: "`SECTION_ORDER`: `system` 25, `guardrails` 40, `memory` 45,
  `references` 50, `subagents` 64, `scripts` 66, `wiki` 80, `tools` 90."
- **INV-PRM-2** "The system prompt holds only stable text: identity, role, the tree's sections, tool
  guidance and the tool manifest. Changing state never enters it."

## Proposal

The compiler adds one harness-owned section to every pack:

- id `reporting`, title "Reporting your work", `SECTION_ORDER.reporting = 95` (after `tools`).
- Fixed text in `src/prompt/compile.ts` (`REPORTING_GUIDANCE`), budget 2,000 characters, never cut,
  no volatile values. It is not dynamic, so `sessionLaunch` puts it in the stable prefix and
  terminal sessions get it through `compile` + `render`.
- It names no application. It yields to any other format the person, the application or the
  current mode (for example plan mode) asks for.

INV-PRM-2 becomes: "The system prompt holds only stable text: identity, role, the tree's sections,
the harness's reporting guidance, tool guidance and the tool manifest. Changing state never enters it."

Section text:

```markdown
When you finish work, write the final reply for a person who did not watch you work.

- Start with the answer or outcome in one or two sentences. If they asked a question, answer it first.
- Then add only the parts that have content, in this order, under short bold labels:
  - **Files**: what you read that mattered and what you changed, as `path:line` with a few words each. Use a table (File | Change | Why) when there are three or more.
  - **Blocked**: what stopped you, what you tried, and what you need from the person.
  - **Worth a look**: risks, surprises, or choices the person may disagree with.
  - **Check by hand**: what you could not verify yourself and how to check it. Name the checks you ran and their result; never claim a check you did not run.
  - **Next steps**: one to three concrete actions, the most useful first.
- Use a Markdown table when comparing options, listing several items with the same fields, or reporting the results of several checks. Use prose or bullets otherwise.
- Keep it short. Skip a part instead of writing "none". A one-line question gets a one-line answer.
- If the person, the application, or the current mode asks for a different format, follow that.
```

## Alternatives

- **Do nothing.** Reply shape stays model-dependent; the request is not met.
- **Default text in the tree (`systemprompt.md`).** Refinement could tune it per scope, but trees
  created before the change never get it, and an adopted refinement could drop it.
- **An application section.** Every application would have to repeat it, and the terminal has none.
- **A harness-built file list from run events.** Always exact, but needs terminal and protocol
  work. Deferred; the model writes the list for now.

## Consequences

- Every system prompt gains about 1,200 characters. The prefix changes once, so each existing
  session's provider cache misses once after upgrade; afterwards it is byte-stable.
- Applications need no change. The App's sidecar bundle must be rebuilt to pick it up.
- No change to stored data or the server protocol. `runs/<id>/context.json` lists the new
  section in `sections` and `delivery.systemSectionIds`.

## Migration

None for data. Undo by removing the section; the prefix changes once more.

## Checks

- `compile.test.ts`: section-id lists end with `reporting`; the section is in the `sessionLaunch`
  system prompt, byte-identical across compiles, and never in a context update.
- Harness `npm run typecheck`, `npm test`; App `npm run typecheck`, `npm test`,
  `npm run check:layers`, `cd src-tauri && cargo test`.
- By hand: a terminal run that reads and edits files ends with a reply in this shape, and its
  table renders.
- Cache effect measured with the App's `scripts/probe-chat-cache-app.py`, only with the account
  owner's permission (INV-PRM-8).
