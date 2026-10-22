---
id: ADR-0004
title: Fullscreen terminal layout with a fixed dock
status: superseded
created: 2026-10-18
updated: 2026-10-21
supersedes: none
superseded_by: ADR-0006
---
# ADR-0004 — Fullscreen terminal layout with a fixed dock

## Context and decision

The owned terminal drew its transcript and composer as one flowing list on the main screen. With a
short transcript the composer sat under the last line and moved down as the transcript grew. Harness
also kept its own scroll offset, mouse regions and paging, which duplicated the viewport Pi already
provides in fullscreen.

Harness now uses Pi's fullscreen renderer by default. The welcome and transcript form a scroll view
that fills the terminal; the dock (working line, queue and notices, widgets, editor and status band,
footer) sits fixed below it. Pi's `tuiMode`, `fullscreenScrollbar`, `fullscreenWheelScrollLines`,
`fullscreenCopyOnSelect` and `fullscreenExitOutput` settings are read from the account and honoured.
`tuiMode: "regular"` keeps the flowing layout on the main screen. When fullscreen ends with
`fullscreenExitOutput: "transcript"`, the rendered conversation is copied into the normal scrollback.

## Consequences

- While fullscreen is running, the transcript is not in the terminal's scrollback. Mouse capture is
  on, so terminal drag-selection gives way to the application's selection, which copies on release.
  These are Pi's defaults and remain changeable in settings.
- Harness no longer owns scroll state, wheel handling or paging. Those come from Pi's viewport and its
  `tui.altScreen.*` bindings, and the keyboard list shows the scroll keys only in fullscreen.
- Regular mode has no Harness-managed scroll position; scrolling there belongs to the terminal.
- When the screen is short, a long notice shows its first rows and scrolls for the rest. The prompt
  and status are never clipped; the head of a notice stays readable, so the newest line of a long
  list may need a scroll.
- Only `transcript` exit output is implemented. Other values write nothing on exit.

## Alternatives considered

Padding the main-screen output to the terminal height also keeps the composer on the last rows for a
short transcript. It keeps native scrollback, but Harness would still own its scrolling and mouse
handling, and the composer would scroll away with the terminal's scrollback once the transcript
overflowed. That was rejected because it keeps the duplicated code this change removes.

## Evidence

The layout is covered by `src/terminal/tui/screen.test.ts`: the dock stays on the last rows as the
transcript grows and scrolls, regular mode flows in order, and the exit copy is written with its styles
reset. The PTY verification of the built CLI is recorded in [the terminal reference](../terminal-tui.md).
