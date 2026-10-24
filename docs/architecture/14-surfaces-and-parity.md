# 14 Surfaces and parity

## Purpose

The harness has more than one front end: its own standalone terminal (`xharness`, page 11) and
every application that embeds it. This page fixes how capabilities relate to those front ends, so
that a person can do the same work in the terminal and in a host, and so that a reader knows that
a capability is Harness work even when a request names a host.

A *capability* is something a person or a model can do: start a session, approve a call, work in
a worktree, annotate a page, inspect a run. A *surface* is how one front end presents it: a
terminal command or page, a host screen.

## Components

| Kind | What it is | Example |
|---|---|---|
| Foundation service | A member of `Harness` with server methods | `sessions`, `accounts`, `apps`, `worktrees` (PROP-0016) |
| Built-in feature plugin | A module in `BuiltinPluginRegistry` (`plugins/builtin.ts`) that may supply a `WorldPart`, server methods and terminal commands | web tools, browser tools, annotations, worktrees |
| First-party plugin | A descriptor in the registry (`plugins/builtin.ts`) | lessons, checklist |
| Terminal surface | A command, page or dialog in `terminal/` | `/plan`, `/plugin:doctor`, the resource browser |
| Host surface | A host screen built on the same methods and tools | the App's chat, Capability and Harness screens |
| Host-backed backend | An operating-system object only a host has, behind a generic Harness contract | the App's WebKit tabs, macOS computer bridge, keychain |
| Host-only surface | Presentation a terminal cannot show (INV-PAR-4) | reserved: interactive agent output ("OpenUI") |

## Contracts

- A capability is reachable through server methods (page 10) and, where a model uses it, through a
  tool that passes the gate (page 07). Both front ends use the same methods; neither has a private
  path to Harness state.
- Plugin-owned terminal commands use `/plugin:<command>`; Foundation commands remain unprefixed.
  Built-in plugin categories are documented in page 06 and are not public plugin metadata.
- The register of capabilities and their surfaces is [`docs/parity.md`](../parity.md). It is
  descriptive; the invariants below are binding.
- A host keeps its own register of host-only surfaces. The Harness names no host surface.

## Invariants

- **INV-PAR-1** Every capability a person can use in a host is a Harness capability: a foundation
  service, a world part or a first-party plugin, reachable through server methods. The standalone
  terminal surfaces it. A host is a presentation of it.
- **INV-PAR-2** A capability is complete only when its terminal surface and its host surface both
  pass acceptance. It lands in the Harness first, together with its terminal surface; the host
  surface follows.
- **INV-PAR-3** A host-backed capability needs an operating-system object only a host has. The
  Harness defines the generic contract and a terminal fallback (for example the headed isolated
  browser for page annotations). Without a fallback, the terminal shows the capability as
  unavailable, with the reason, in `/plugin:doctor` and `/tools`.
- **INV-PAR-4** A host-only surface owns no capability. Its actions are Harness methods or tools,
  its data lives in Harness records, the terminal renders a text fallback, and each one is listed
  in the host's register by an owner decision. A generic rich-output event kind for such surfaces
  needs its own proposal; the name is reserved and nothing is designed.

## Data

None of its own. Each capability stores its data as its own page says.

## Source map

`src/harness.ts` (services), `src/world/world.ts` (world parts), `src/plugins/builtin.ts`
(first-party descriptors), `src/terminal/` (terminal surfaces), `src/server/methods.ts` (methods).
Decision: [PROP-0015](proposals/PROP-0015-one-capability-surface.md),
[ADR-0017](../decisions/ADR-0017-one-capability-surface.md).
