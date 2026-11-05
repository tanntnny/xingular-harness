---
id: ADR-0087
title: One model and effort selection for normal and plan
status: accepted
created: 2026-11-05
updated: 2026-11-05
related: [ADR-0064, ADR-0023, FEAT-0013]
supersedes: null
superseded_by: null
---

# ADR-0087 — One model and effort selection for normal and plan

## Context

The terminal used to keep a model and effort for each composer mode. `ModeChoices.apply` ran on every
`setMode`, `submitPlan` applied plan's choice, and leaving plan mode applied normal's again. The result
was two visible surprises: Shift+Tab changed the model and effort, and choosing **Implement** on a
finished plan could run the implementation on a different model than the one the person had been
looking at. A model picked with Enter in `/model` was also session-only in the client runtime, so the
next mode change could replace it with an older saved choice.

The App already keeps one account, model and effort tuple on each Thread (App ADR-0023), and its plan
mode shares that tuple. A separate planning model is an explicit non-goal of App plan mode
(FEAT-0013). The terminal's per-mode behavior was the outlier.

## Decision

The terminal keeps one model and effort selection per account.

- A new conversation starts on the account's saved selection. A resumed conversation keeps the model
  and effort recorded in its own history while the account can use them.
- Composer modes never change the selection. Shift+Tab changes tools, prompt sections and the
  composer's appearance; **Implement** leaves plan mode and submits the plan prompt with the same
  model and effort.
- Every explicit selection (the model picker, `/effort`, Shift+Up/Down, Ctrl+P, or a direct
  `setModel`/`setThinkingLevel` from the terminal) is saved for the account. Internal history
  restores and fallbacks are quiet and are never recorded as the person's pick.
- When the conversation's model is unusable on this account, the runtime starts it on the saved
  selection with that selection's effort, records the model change in the conversation, and reports
  it once. The saved selection itself is not changed by a fallback.
- `choices.json` now stores the flat `{ model?, effort?, updatedAt }` shape. A legacy file with
  `{ modes: ... }` contributes its valid entry with the newest `updatedAt`; a tie prefers `normal`,
  then `plan`. The next save writes the flat shape.
- The account methods are `accounts.selection` and `accounts.select`; the terminal's own account
  calls are `accounts.selection.get` and `accounts.selection.set`.

## Alternatives considered

- **Keep per-mode choices and make them visible.** Rejected: the person still sees the model change
  when switching modes or implementing, and the mode-specific choice is easy to forget. Making it
  visible does not make the selection stable.
- **Make every pick session-only.** Rejected: a new conversation would forget the choice, and the
  person would have to pick again. The account selection is the stable default the request asked for.
- **Keep a separate planning model.** Rejected for now: App plan mode already treats that as a
  non-goal, and it caused the reported surprise. It can return later as an explicit, visible
  per-mode override if there is a real need.
- **Keep the legacy mode keys in the file.** Rejected: the mode dimension is what made the behavior
  ambiguous. The file name stays for migration, but the stored concept is one selection.

## Consequences

- The model and effort shown in the status bar stay the same across normal and plan, and after
  Implement.
- A plan run cannot silently use a cheaper or different model. A person who wants that must change
  the selection before planning or after planning, explicitly.
- A `choices.json` written by an older release is migrated on read. An account whose newest legacy
  choice was made in plan mode adopts that choice as its one selection.
- `Ctrl+P` and `Alt+P` now change the model in the client runtime; before this record the client's
  `cycleModel` was a no-op.
- Hosts that called `accounts.choices` or `accounts.choose` must use `accounts.selection` and
  `accounts.select`. No in-repository host called the old names.

## References

- `src/accounts/selection.ts` (`readSelection`, `saveSelection`)
- `src/terminal/tui/modelSelection.ts` (`ModelSelection.useFallback`, `ModelSelection.record`)
- `src/terminal/tui/runtime.ts` (`recoverModel`, fresh-session selection)
- `src/terminal/tui/harnessRuntime.ts` (`applyConversationSelection`, `cycleModel`, `startRun`)
- `src/terminal/opentui/app.ts` (`switchComposerMode`, `implementPlan`)
- [11 Terminal](../architecture/11-terminal.md), [09 Accounts](../architecture/09-accounts-and-connectors.md),
  [terminal and TUI](../terminal-tui.md)
- ADR-0064 (the fallback rule; its per-mode premise is retired here)
