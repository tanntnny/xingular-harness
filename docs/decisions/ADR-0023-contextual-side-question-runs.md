# ADR-0023: Contextual side questions are Harness runs

**Status:** Accepted  
**Date:** 2026-10-24  
**Proposal:** [PROP-0019](../architecture/proposals/PROP-0019-contextual-side-questions.md)

## Context

The terminal and App had separate `/btw` implementations. The terminal used a short, in-memory
Pi session; the App used a bounded, tracked run. Their answers could not consistently use the main
run's instructions or public tool evidence, and they had different lifecycle and observability.

## Decision

The Harness owns one side-question service. It creates an independent run with no variant and an
empty frozen capability set. The service uses a redacted projection of the main run's effective
prompt, visible transcript, and persisted public events, including tool inputs and results. It
excludes hidden reasoning and attachment bytes. Context is bounded, credential-like material is
redacted, and transcript/tool content cannot add permissions. Terminal and host surfaces use the
same service and ordinary run-event contract.

## Consequences

Side answers are separately recorded and can be inspected with ordinary run history and usage.
They never enter or steer the parent conversation. No persistent side-thread store or migration is
needed. The terminal presents a temporary scrollable dock; a host keeps its own presentation. The
App's read-only native file tools use the operating system's read boundary across absolute and home
paths; the App's host gate continues to protect edits, writes and shell commands.

## Rejected options

- Keeping a separate in-memory terminal session would preserve different answers and observability.
- Sending hidden reasoning, images or the main run's tools would expose more than a side answer
  needs and could let it act independently.
- Persisting side threads would require retention, deletion and synchronization rules.
