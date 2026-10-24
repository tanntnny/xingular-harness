# 04 Prompt

## Purpose

One compiler builds every model instruction the harness gives. It merges the pinned variant's
sections, the harness's own sections and the application's sections into an ordered,
budgeted pack, then splits the pack into a **stable system prompt** (cached by the provider) and
a **context update** (changing state appended to native history). Keeping the two apart is what
keeps provider caching effective across turns.

## Components

| Type / function | Role |
|---|---|
| `compile(env, caller, launch, variant)` → `ContextPack` | Builds the ordered, budgeted sections, including the configured data-root path in native file guidance. |
| `render(env, pack)` → `string` | One string for a session that takes a single prompt. |
| `sessionLaunch(env, caller, launch, historyFile, variant)` → `{ system, update, pack }` | SDK sessions: stable prefix plus an update with only the dynamic sections that changed since the last delivered snapshot. |
| `deliveredSnapshot(sessionFile)` | Reads the last delivered snapshot on the active history branch; a compaction forces a fresh one. |
| `saveForSession`, `copyToRun` | Terminal sessions keep the pack they started with and copy it to each run. |
| `record`, `load`, `packPath` | The pack each run was given, at `runs/<id>/context.json`. |
| `toolGroups`, `fit`, `clip` | The tool manifest by group; cutting text to a budget at a paragraph boundary. |

All in `prompt/compile.ts`. A `ContextPack` holds `sections: Section[]` (each with `id`, `title`,
`body`, `sources`, `budget`, `size`, `cut`), `toolGroups`, `harness` (scope and fingerprint),
`profile`, `compiledAt` and `delivery` (`systemSectionIds`, `updatedSectionIds`).

## Section order

`SECTION_ORDER`: `harnessIdentity` 5, `system` 25, `guardrails` 40, `memory` 45, `references`
50, `subagents` 64, `scripts` 66, `wiki` 80, `tools` 90, `reporting` 95. Application sections
sit among them by their `order`; plan mode uses `plan` at 25. Ties keep insertion order.
When a run may spawn, `subagents` lists every agent profile it can start (built-in, global,
project and the variant's c5 names) and replaces the variant's own list (PROP-0029). The `tools`
section has a Progress paragraph whenever `checklist_write` is available: it asks for a checklist
early and kept current, because the person follows work from it (PROP-0006).

The fixed `harness-identity` section says `You are an AI agent running in <productName>.` and uses
`env.productName` (default `Xingular Agent`). Host-provided identity and role sections remain
separate, so an embedding application can still describe its agent and task.

Budgets (characters): variant sections 30,000 each (already capped at save, so never cut here);
references 12,000; Wiki pointer 2,500; tools 8,000; reporting 2,000; application sections their
own `budget`.

## Reporting

Every pack ends with the harness's `reporting` section ("Reporting your work",
`REPORTING_GUIDANCE` in `prompt/compile.ts`). It is fixed text that shapes the final reply: lead
with the answer or outcome, then use only headings or structure that help explain it; no fixed list
of report headings is required. When a concrete verification requires a person because the agent
could not perform or observe it, the optional **Need human inspection** heading says what remains
unverified, why, and the specific check the person should make. Report only checks actually run,
with their results. Markdown tables are used where they help compare options or present repeated
fields or check results; any format the person, application or current mode asks for takes
precedence. The section names no application, is never dynamic, and is never cut. See
[PROP-0001](proposals/PROP-0001-reporting-section.md),
[PROP-0004](proposals/PROP-0004-flexible-reporting-guidance.md), and
[ADR-0008](../decisions/ADR-0008-flexible-reporting-guidance.md).

## Delivery

```text
compile ──► pack ──► stable sections ──► system prompt (+ "Context updates" guidance)
                └──► dynamic sections ──► compare with delivered snapshot ──► custom message
                                                                              type xingular-context
```

- Dynamic sections are the built-in `references` and `wiki`, plus every application section with
  `dynamic: true`.
- An update lists only the dynamic sections that changed, and announces a withdrawn one.
  `references` is always resent when present, because it belongs to the current request.
- The session appends the update as a hidden custom message and saves its snapshot in the
  message details (`xingularContext`); recording a pack does not mark it delivered.
- Terminal sessions use `compile` + `render` once, pass it as `--append-system-prompt`, and keep
  that pack for the life of the session.
- Read-only native file guidance states that absolute and `~` paths work when the operating system
  permits access, names the configured data root, and describes the working folder as a default
  location. Edits and commands remain subject to the gate.
- A side-question launch attributes its fixed no-tool instruction to the `side-questions` plugin.
  Its launch suppresses tool guidance entirely. The main run's effective prompt and current context
  update are included in the separately bounded, redacted context message (PROP-0019).

## Invariants

- **INV-PRM-1** The prompt is assembled only in `src/prompt/compile.ts`. Nothing else builds model
  instructions. SDK sessions use `sessionLaunch`; terminal sessions use `compile` + `render`.
- **INV-PRM-2** The system prompt holds only stable text: identity, role, the variant's sections, the
  harness's reporting guidance, tool guidance and the tool manifest. Changing state never enters it.
- **INV-PRM-3** `references`, `wiki`, and every section the application marks `dynamic` are
  delivered as context updates in native history, never in the system prompt.
- **INV-PRM-4** An update carries only changed dynamic sections, so an unchanged turn appends
  nothing. A compaction on the active branch forces the full snapshot again.
- **INV-PRM-5** The pack only describes tools the caller can call (the frozen capability set).
  `ask_user` is not part of the compiler's tool-group manifest; its mode-specific availability is
  resolved with the run's callable tools (page 02).
- **INV-PRM-6** Each run's pack is recorded beside the run. Failing to record it never fails the
  session.
- **INV-PRM-7** The compiler is synchronous (`INV-BND-4`).
- **INV-PRM-8** Whether a prompt or callable tool-list change keeps the provider's cache is measured
  with real requests from the application, only with the account owner's permission. Tests do not
  stand in for it.
- **INV-PRM-9** Native file guidance describes the existing OS-permission boundary accurately:
  absolute and `~` paths are valid for read-only file tools; the working folder is not a sandbox.
  Side-question runs with no callable tools omit tool guidance.

## Relation to DESIGN-0001

[`../system-prompt-design.md`](../system-prompt-design.md) is a draft design (not accepted). Only
what this page states is binding. Adopting parts of that draft is an architecture change.

## Source map

`src/prompt/compile.ts`, `src/sessions/sessions.ts` (calls `sessionLaunch`),
`src/terminal/terminals.ts` (calls `compile` + `render`), `src/variant/materialise.ts` (variant
sections), `src/sessions/planMode.ts` (`plan` section).

## Session naming guidance (PROP-0010)

The Session tool group describes `session_name` when available: name meaningful work early
with an imperative sentence of at most six words, and revise when the objective changes.
This is fixed foundation guidance. The current name stays in native session metadata and
the terminal snapshot; it is never interpolated into the stable system prompt.
