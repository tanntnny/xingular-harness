# 14 Surfaces and parity

## Purpose

The harness has more than one front end: its own standalone terminal (`xagent`, page 11) and
every application that embeds it. This page fixes how capabilities relate to those front ends, so
that a person can do the same work in the terminal and in a host, and so that a reader knows that
a capability is Harness work even when a request names a host.

A *capability* is something a person or a model can do: start a session, approve a call, work in
a worktree, annotate a page, inspect a run. A *surface* is how one front end presents it: a
terminal command or page, a host screen.

## Components

| Kind | What it is | Example |
|---|---|---|
| Foundation service | A member of `Harness` with server methods | `sessions`, `accounts`, `apps`, `worktrees` (PROP-0016), agent profiles (`agents.*`, PROP-0029) |
| Built-in feature plugin | A module in `BuiltinPluginRegistry` (`plugins/builtin.ts`) that may supply a `WorldPart`, server methods and terminal commands | web tools, browser tools, annotations, worktrees |
| First-party plugin | A descriptor in the registry (`plugins/builtin.ts`) | lessons, checklist |
| Terminal surface | A command, page or dialog in `terminal/` | `/plan`, `/doctor`, the resource browser |
| Host surface | A host screen built on the same methods and tools | the App's chat, Capability and Harness screens |
| Host-backed backend | An operating-system object only a host has, behind a generic Harness contract | the App's WebKit tabs, macOS computer bridge, keychain |
| Host-only surface | Presentation a terminal cannot show (INV-PAR-4) | reserved: interactive agent output ("OpenUI") |

## Contracts

- A capability is reachable through server methods (page 10) and, where a model uses it, through a
  tool that passes the gate (page 07). Both front ends use the same methods; neither has a private
  path to Harness state.
- Required built-in plugin commands and Foundation commands use unprefixed names. Optional built-in
  plugin commands and Pi extension commands use `/plugin:<command>`. A bare command, alias or loaded
  prompt owns its name; a colliding prefixed command is hidden and rejected. Built-in plugin
  categories are documented in page 06 and are not public plugin metadata.
- A capability may be limited to a run mode when Harness resolves the callable set; the register
  records that restriction for both surfaces. `ask_user` is available only in attended plan runs,
  and the terminal's `ask_user_question` alias follows the same restriction.
- Question choice sketches use one optional validated event contract: up to 80 printable ASCII
  columns by 24 LF-separated lines (1,943 bytes maximum; page 02). Both surfaces use the same
  literal ASCII source, persisted unchanged, in one shared preview with access to overflow; neither
  changes the answer payload (PROP-0025, ADR-0026; originally PROP-0024). The terminal may project
  recognized ASCII table-border rows—including title-bearing rules—and enclosed vertical table
  edges into connected box-drawing glyphs, retaining internal framed table widths. For a
  high-confidence frame, it may fill a missing boundary cell or realign a displaced edge only
  through whitespace to matched corner columns; interior text and ambiguous rows remain unchanged
  (PROP-0028, ADR-0029). Bare standalone hyphen dividers expand to the larger of viewport width and
  original sketch widest line and join the outer single-line frame with `├` and `┤` (PROP-0026,
  ADR-0027). Prose, content operators and ordinary pipes are not globally substituted. Hosts may
  retain literal ASCII previews: equivalent capability does not require identical structural
  typography. No schema, validation-bound, persistence or answer-payload change follows from these
  display amendments. Terminal geometry, scrolling and projection boundaries follow page 11; hosts
  may use native presentation without narrowing accepted metadata. Existing hosts with the old
  bounds must update before accepting larger sketches. Acceptance of the expanded contract on both
  surfaces is tracked in the parity register. Isolated production PTY evidence verifies bounded
  fixture topology, not every emulator/font or live-model sketch quality.
- Side questions use one Harness service on both surfaces. Each caller supplies its visible
  transcript projection; Harness adds the parent run's effective prompt and public events, then
  starts an independent tool-free run.
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
  unavailable, with the reason, in `/doctor` and `/tools`.
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
