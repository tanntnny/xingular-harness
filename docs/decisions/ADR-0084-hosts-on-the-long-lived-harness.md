---
id: ADR-0084
title: Hosts connect to the long-lived harness
status: accepted
created: 2026-11-05
updated: 2026-11-05
related: [ADR-0083, ADR-0056, INV-SRV-5, INV-SRV-7, INV-RC-5, INV-RC-9, INV-BND-2, INV-PAR-1, PAR-018, PAR-019]
supersedes: null
superseded_by: null
---

# ADR-0084 — Hosts connect to the long-lived harness

## Context

ADR-0083 made the terminal a client of the harness and added a long-lived harness (the daemon), so a
reply outlives its window. A host such as an application's sidecar still embeds its own harness. Two
processes then write one data root, and the host's replies end when it quits. Making the daemon the
default for terminals widens that gap: a terminal open all day would sit beside the host's own writer.

The host cannot simply connect, because it gives the harness things only it has, as in-process objects:
the Keychain, a per-call tool policy, names, native tools that report into a live run, a connected-apps
broker and a refine host. The daemon also serves terminal windows, whose runs must not be gated by a
host's policy.

## Decision

1. A host connects to the daemon's socket and registers (`host.register`) with its own name and what it
   supplies. What it supplies arrives as calls the harness makes back to it, the same calls a non-Node
   host answers over stdio. `HarnessClient.handle` answers them.
2. A session belongs to the host whose connection started its run, and a subagent's to its parent's host.
   Policy, tools, the broker and event delivery are routed by that owner. A run with no host is never
   gated by one. A host that is gone fails its sessions' calls (`host_unavailable`) and approves nothing.
3. A host that starts the daemon passes its construction options in a launch file; the lock records its
   hash, and a host or window needing another launch replaces an idle daemon or is refused while it is used.
4. A host quitting only disconnects. Its replies go on; its next connection catches up from the run logs.
5. `harness.open` of the open root changes nothing over the protocol.
6. Remote control moves from a terminal session to a live conversation (INV-RC-5, INV-RC-9), so a phone
   can reach a host's chat, and a pairing outlives a closed terminal window while its reply runs.
7. The default did not flip in this change; ADR-0085 flips it for terminals and for the App's sidecar.

## Consequences

- One writer per data root becomes possible for a host that opts in (INV-SRV-7); it is not yet the default.
- The harness gains a host registry (`server/hostHub.ts`) and a lighter client module
  (`server/daemonClient.ts`) a host can import without the terminal.
- A daemon started by a terminal has no host options; a host that needs its own gets a new daemon when
  the first is idle, or runs with its own harness. Browser tools of a host's daemon come from the host (or
  a paired browser); a terminal window in that daemon has no generic browser.
- Work left when this was written: the soak, the default flip (ADR-0085), and a hung-plugin test.
