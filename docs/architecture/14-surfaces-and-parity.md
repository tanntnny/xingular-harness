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
| First-party plugin | A descriptor in the registry (`plugins/builtin.ts`) | lessons, todo |
| Terminal surface | A command, page or dialog in `terminal/` | `/plan`, `/doctor`, the resource browser |
| Host surface | A host screen built on the same methods and tools | the App's chat, Capability and Harness screens |
| Host-backed backend | An operating-system object only a host has, behind a generic Harness contract | the App's WebKit tabs, macOS computer bridge, keychain |
| Host-only surface | Presentation a terminal cannot show (INV-PAR-4) | reserved: interactive agent output ("OpenUI") |

## Contracts

- A capability is reachable through server methods (page 10) and, where a model uses it, through a
  tool that passes the gate (page 07). Both front ends use the same methods; neither has a private
  path to Harness state. Foundation context behavior, including bounded checkpoint restoration after
  compaction (PROP-0033), is shared by terminal and embedded sessions; a host does not reimplement it.
  The direct `/plugins` page manages local plugin state and package lifecycle; `/hub` presents the
  Community catalog and all installed Hub receipts. These are distinct presentations of existing
  Harness services, not host-only capabilities. The broad `/harness` browser remains available.
- Workspace write scope is Harness-owned on both surfaces. Each run pins a canonical root after
  worktree selection; reads retain OS-permission scope, while native file writes and shell
  filesystem effects default to that root; the filesystem root itself is not a valid workspace.
  Native mutations revalidate their canonical target and atomically replace the file under an OS
  write scope. Default Bash scans for external hard-link
  aliases and runs under an OS sandbox that prevents its own processes from creating cross-boundary
  hard links; on macOS the sandbox denies hard-link creation entirely, including within the
  workspace. `workspaceWriteScope: 'outside'` (terminal `!outside <command>`) requests a human-only
  approval before one execution, showing the complete escaped command in scrollable terminal details
  and denying if the terminal is too small. Output never triggers approval or retry. Hosts may
  tighten or deny policy but cannot silently waive the boundary. Only the eligible Full Permission
  switch may answer automatically under its existing restrictions. A same-user peer process outside
  Harness is not controlled by this rule. `workspaceRoot` is additive and legacy run records may
  omit it.
- Harness core terminal commands use unprefixed names and are registered independently of feature
  plugin command metadata. This includes `/doctor`, `/worktree`, `/trajectory`, `/subagents` and
  `/agents`; `/history` remains session-branch navigation, and `/mcp` remains a Connections shortcut.
  Every plugin-owned terminal command uses `/<owner-prefix>:<command>`, for required and optional
  built-ins and Pi extensions alike. Built-in prefixes are stable registry metadata; Pi package
  extensions use a normalized package name or the package's `harness.commandPrefix`, and loose
  extensions use their normalized extension name. Prefix collisions and duplicate commands within
  one owner are rejected with owner diagnostics. Built-in plugin modules may declare a default
  command for their namespace root. The former owner-qualified and `/plugin:<command>` forms of
  promoted Harness commands remain hidden compatibility aliases for one release. Prompt templates
  and `/skill:<name>` keep their existing forms. Built-in plugin categories remain documented in
  page 06, not public metadata.
- A capability may be limited to a run mode when Harness resolves the callable set; the register
  records that restriction for both surfaces. `ask_user` is available only in attended plan runs,
  with no terminal-only question alias (PROP-0040). Plan-mode delegation
  is limited to named profiles whose effective tool and plugin allowlists qualify for read-only
  research; both terminal and host use the same gate and child-capability narrowing.
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
- PROP-0040 defines one shared launch/command contract: `Launch.standard`, `commands.list`,
  saved-history controls and tracked `SessionRunInput.command` runs. Hosts present these rather
  than approximating navigation with a fork. A listed command or handler is not proof of acceptance.
  The current host `/session` picker reads a host-owned session catalog rather than a shared Harness
  catalog (PAR-008), and read-only command pages do not stand in for unsupported management methods.
  The register records command routes individually; parity remains open until each route passes
  acceptance.
- Read-only `get_capabilities` is implemented in structured sessions and the terminal. Structured
  sessions report tools filtered by the run's frozen capability set and actual registered schemas;
  the terminal reports Pi's active tools and schemas, applying its plan-mode allowed set when active.
  It is in the shared plan-mode allowlist and grants no permission. Hosts use this Harness tool rather
  than defining a duplicate.
- `browser/contracts.ts` owns shared backend-neutral browser schemas. A native WebKit host backend
  lacks accessibility snapshots and snapshot-ref interactions, waits and keyboard input; it supports
  page screenshots without refs in source, with live acceptance pending. Unsupported calls return an
  explicit refusal before effects and do not trigger an automatic backend switch (page 13, PAR-015).
- Shared interactive defaults, profile adoption, credentials and a cross-surface session catalog
  remain in progress under PROP-0040. Existing pins and explicit profile choices win; adoption must
  not merge stores, copy credentials or silently downgrade the secret backend.
- `PluginDescriptor.surfaces` / `Plugin.surfaces` optionally describe a host preference, terminal
  fallback/unavailability and reason. This labels add-ons, not plugin categories or permissions.
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
[ADR-0017](../decisions/ADR-0017-one-capability-surface.md),
[ADR-0036](../decisions/ADR-0036-workspace-write-operation-boundary.md).
