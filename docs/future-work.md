# Future feature backlog

This backlog records candidate directions. An entry here does not change the binding architecture,
approve implementation, or describe an available feature. A change to an architecture contract,
invariant, layer boundary, extension point, or storage layout still requires a reviewed proposal.

## FW-0001: Agent Modes, starting with Router Agent Mode

**Status:** Candidate; future architecture proposal required before implementation.

### Concept

An **Agent Mode** selects one overall work style, with only one mode active at a time. Plugins remain
stackable strategies and contributions that can be used within a mode; they do not select the
agent's overall work style.

The first planned mode is **Router Agent Mode**. The user interacts with one user-facing agent through
one continuous chat and browser experience. That router proactively plans and delegates work across
persistent subagent threads, receives their messages, and coordinates the overall work while the user
can continue sending messages.

### Intended ownership

This is intended as a Harness foundation capability. The current architecture describes subagents as
child runs and assigns persistent teams, broader orchestration, and the application's shared UI to
the embedding application ([02 Sessions and runs](architecture/02-sessions-and-runs.md), [feature-gap
review](study/feature-gap-review.md)). This backlog entry proposes revisiting that boundary; it does
not change it.

### Decisions required before a proposal

- Define the mode selection scope and lifetime, including how one active mode applies to sessions,
  runs, and child agents.
- Define persistent subagent thread identity, history, communication, delegation, recovery, and
  resource limits while preserving the run's account, variant, capability, and gate guarantees.
- Define how the router receives worker messages and incorporates them while accepting continued
  user input in one conversation.
- Define how the single chat and browser experience maps to the Harness terminal, server protocol,
  and embedding hosts, including which UI responsibilities remain with the host.
- Identify the storage, run-event, and public API changes needed to support the mode and migrate or
  coexist with current run-scoped subagents.

### Next step

When implementation is scheduled, write a formal architecture proposal from the proposal template,
identify every affected contract and invariant, and obtain acceptance before changing code or binding
specification pages. Record a lasting accepted architecture choice in an ADR. Until then, Agent Mode
and Router Agent Mode are planning terms only; no runtime behavior or public interface is implied.
