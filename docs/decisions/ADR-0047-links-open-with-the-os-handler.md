---
id: ADR-0047
title: A link a person clicks opens with the system's own handler, through one allowlist
status: Accepted
created: 2026-11-20
---

# ADR-0047: A link a person clicks opens with the system's own handler

## Decision

- `core/links.ts` holds the one link policy: `linkTarget` classifies a target without touching the
  filesystem (`http`/`https`, `mailto`, `file`, an absolute path, or a relative path under a
  supplied base), and `openableTarget` checks what a path names before anything is launched.
- A path may be opened only when it is a regular file or a directory, is not an application bundle
  or an installer, is not a launchable script kind (`.command`, `.sh`, `.bat`, `.pkg`, `.dmg`,
  `.app`, …), and has no executable bit set. The last two matter because `xdg-open` runs an
  executable file and `open` launches a bundle.
- The address reaches `open` (macOS), `xdg-open` (Linux and the BSDs) or `rundll32.exe
  url.dll,FileProtocolHandler` (Windows) as one argument, never through a shell.
- `links.open` is a server method, so a host presents the same capability, and the terminal is the
  reference surface: hovering a link recolours it, and the gesture the platform uses opens it —
  Ctrl+click where a terminal reports the modifier, and the primary click on macOS, whose ⌘ the
  terminal mouse protocol cannot carry. The opener is `HarnessOptions.linkOpener`, so a host with
  its own native opener replaces the spawn and keeps the policy.
- A link is a person's action. Nothing here is in `HARNESS_TOOLS`, so the gate, standing approvals
  and redaction are not involved, exactly as with `variants.save`.
- Both front ends show the hover state: the terminal repaints the hovered link's spans in
  `theme.linkHover`, and the App uses the shared `--link-hover` token on `a:hover`. The App's
  modifier is the platform's own: ⌘ on macOS, Ctrl elsewhere.

## Rationale

The terminal opened web links only, and the App opened web pages and stored documents in its
sidebar while silently swallowing everything else — `mailto:`, folders, relative paths and unknown
kinds. The allowlist existed three times (a terminal module, the App's TypeScript, and the App's
Rust), which is the drift the parity rules exist to prevent. One policy in the Harness, used by
both surfaces, is the smallest thing that makes a link behave the same everywhere.

## Consequences

A refused link is reported, never ignored: the terminal posts a notice and the App reports an
error. Opening a document still hands its bytes to whichever application the system has associated
with that kind, which is inherent to the request; the deny list and the executable-bit check are
the boundary, not a sandbox. A host that wants different kinds to open replaces `linkOpener`, and
an architecture change would be needed to let a model open a link on its own, because that would
put an operating-system action inside the gate's reach.
