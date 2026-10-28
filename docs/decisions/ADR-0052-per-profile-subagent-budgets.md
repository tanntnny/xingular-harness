# ADR-0052: Per-profile and total subagent budgets

A run could start any number of children: `maxDepth` bounded nesting only. Run `90906235`
("Implement the plan: Safe screenshot capability", 2026-10-28) started 11 children in nine
minutes for a five-step plan — three spawns before the parent had read a file, five children that
returned no change, and two tasks retried as fresh children. The shape of delegation was left to
the prompt.

A run now starts only a bounded number of distinct child conversations. Foundation defaults: four
children in total, two `worker`, three `explorer`, one of any other named profile and one with no
profile. A host overrides them through `SessionRunInput.subagents` (`maxChildren`, `maxByProfile`,
`maxOther`, `maxUnprofiled`), so the terminal and the App receive the same defaults; every value
is an integer clamped to 0–50.

`Subagents.spawn` counts the run's recorded children in `subagents.json`, the children of the
parent runs it was continued from (`resumedFromRunId`), and slots reserved by concurrent calls. It
deduplicates a continuation to its first link, so continuing a stopped child uses no new slot,
while a child whose startup failed still counts. A refused spawn returns an `invalid_request`
tool result telling the model to do the work itself; it creates no run. `continue` bypasses the
check because it is the same child.

The budget is per run, not per conversation, so a long chat is not starved. It lives in the
foundation because it bounds what every application built on the harness may spend, and changing
it needs a release. A host that legitimately needs more children raises the limits for its
session; the spawn tool's description states the effective numbers.
