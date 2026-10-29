---
id: ADR-0064
title: A conversation this account cannot use starts on the account's newest selection
status: Accepted
created: 2026-10-30
---

# ADR-0064: A conversation this account cannot use starts on the account's newest selection

## Context

Each mode keeps a model and effort per account in that account's `choices.json`, and a fresh
conversation starts on the normal mode's selection. A *resumed* conversation instead keeps the model
in its own history, which is right while the account can use it. After an account switch, a
signed-out provider or a retired model it cannot: the conversation's branch names a provider this
account has no credentials for.

Nothing in the Harness decided that case. Pi noticed the failed restore, set a
`modelFallbackMessage`, and picked a model itself — the settings default, then the first available
model of the account, restored effort from the branch. The person's own choice for that account was
never consulted, and the run recorded a model the person had not selected for that conversation.
The case that prompted this record: a conversation written on one account (a Codex model) was
resumed on another, and a run started on a different provider's model at a *maximum* reasoning
level that no step in the conversation had chosen. Because the change is applied at session
creation, the transcript held no `model_change` entry, so the model could not even be traced from
the conversation.

## Decision

The terminal runtime owns the start model of every conversation, and the rule is:

- A conversation keeps the model in its history while this account offers it and holds credentials
  for its provider. An explicit `--model` from a host still wins, and a fresh conversation still
  starts on the normal mode's saved selection.
- When the conversation's model is not usable, the conversation starts on **this account's newest
  saved selection**, resolved field by field: the current mode's choice, then normal's, then the
  newest selection in any mode (by `updatedAt`). Its effort comes from the same resolution. Each
  candidate model is checked for being offered and authenticated, and skipped when it is not.
- That start is a change the terminal makes itself. It is written into the conversation as a
  `model_change` entry — so the next resume is settled and a run's recorded model is traceable —
  and it is *never* written to the account's `choices.json`: a fallback is not a selection the
  person made.
- The person is told once, in a terminal notice: which model was replaced and which one is used. With
  no usable saved selection the notice falls back to Pi's own `modelFallbackMessage`, and the
  session still starts.

## Alternatives considered

- **Adopt the account's newest selection on every account switch.** Rejected: an account switch
  between two accounts that share a provider would silently drop a conversation's model and effort,
  which is still valid work.
- **Resolve the model at the `accounts.relaunch` / `prepare` seam and pass `--model`.** Rejected:
  that seam cannot tell whether the conversation's model is usable on the target account, so it has
  the same override problem; it also misses `/session` resume, forks and a provider that was signed
  out while the account stayed the same.
- **Do nothing and rely on Pi's fallback.** Rejected: Pi cannot know the person's account choice, and
  it leaves the run's model unexplained in the transcript.
- **Block the resume until a model is chosen.** Rejected: a switch or a resume must not dead-end on a
  model question; a notice plus a working default keeps the conversation usable, and `/model`
  remains one command away.

## Consequences

- A conversation carried to a new account is deterministic: the same account selection decides it
  every time, and the transcript records the resulting model change.
- The conversation gains one `model_change` entry per account it cannot be continued on, which is
  the audit trail for the run's model and effort.
- The account's saved choices are unchanged by a fallback, so the person's last deliberate selection
  for the account and the mode still applies to the next conversation.
- A host that reads a run's model sees the model the run actually used, not the one recorded in the
  older part of the conversation.

## References

- `src/accounts/choices.ts` (`latestChoice`, `startChoice`, `startModels`, `resolveChoice`)
- `src/terminal/tui/modeChoices.ts` (`ModeChoices.start`, `ModeChoices.useFallback`)
- `src/terminal/tui/runtime.ts` (`recoverModel`, `recordedModel`, `usableModel`, `bind`)
- [11 Terminal](../architecture/11-terminal.md), [09 Accounts](../architecture/09-accounts-and-connectors.md),
  [terminal and TUI](../terminal-tui.md)
