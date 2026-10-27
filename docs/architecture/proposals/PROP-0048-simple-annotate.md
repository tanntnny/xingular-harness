---
id: PROP-0048
title: One annotate page, two actions, and easy app attach
status: Implemented
created: 2026-10-27
updated: 2026-10-27
affects: [PROP-0018, 07-tools-and-gate.md, 10-server-protocol.md, 11-terminal.md, 13-world-tools.md, terminal-tui.md, parity.md]
---

# PROP-0048: One annotate page, two actions, and easy app attach

## Problem

People testing `/annotate:` found it hard to use:

- `/annotate:annotate` duplicated `/annotate:` in every command list.
- With no address, the page asked for one in a dialog that opened *behind* the full-screen page.
  `PageOverlay` started its page in its constructor, before `dialogs.custom` mounted the overlay,
  so any dialog the page opened as it started was stacked below it.
- While that hidden dialog waited, the page's single-action guard dropped every key (`s`, `i`)
  without a word: "send queue sometimes doesn't work".
- A send held back while the agent was busy was tried once, 250 ms after the run ended. If the
  terminal still reported its turn as active, the notes waited forever.
- `/annotate:notes` was a separate centred dialog with its own capture flow.
- The popover had three choices (save, ask the agent to fix, proceed now), the page had a queue, a
  confirm step, an unqueue key and a "fixed" status reported by the agent's `page_notes_mark_fixed`.
- Attaching an Electron app needed its DevTools address typed by hand.

## Design

**Delivery.** A note is either **pending** (shared with the session, unsent) or **sent**.
`NoteDelivery.state` is `pending | sent`; records written before this read `queued` as `pending`
and `fixed` as `sent`, without a migration write. Every annotation made in the inspector with a
session is shared with it at once. The popover has two buttons: **Annotate** (`save`) and
**Annotate & send** (`send`, also Cmd/Ctrl+Enter); `send` sends *all* the session's pending notes
as one message. Any other action the page reports is a save. Page-origin notes (DevTools or
bridge, untrusted) still wait for the person's confirmation; the terminal asks once for all of
them, and an `empty` send reports how many still wait.

`NoteDeliveries.runEnded` now tries a held-back send again (250 ms, 1 s, 3 s, 8 s) while the
session answers `busy`, and starts over if another run ends meanwhile.

`/annotate:submit <request>` sends the pending notes with the person's request after them
(`compose(notes, prompt)`). With no pending notes it sends nothing. A request is not kept while
the agent is busy; the notes stay pending and the person submits again. `/annotate:clear` resolves
the session's pending notes and withdraws their grant to it; they can be reopened from
`/annotate:notes`.

`page_notes_mark_fixed` is removed; the agent's page-note tools are read-only again. Only the
person resolves a note.

**Commands.** A built-in command may be `rootOnly`: it is the namespace root (`/annotate:`) and has
no named route, is not listed, and is not reachable as `/plugin:<name>`. The annotations plugin has
`/annotate: [url | --app [port] | --bridge]`, `/annotate:notes`, `/annotate:submit` and
`/annotate:clear`.

**One page.** `AnnotatePage` is one full-screen page with an **Annotate** tab and an **All
annotations** tab (`/annotate:notes` opens on the second). The Annotate tab takes the page address,
a DevTools port or an app path in an inline field, never a dialog. `a` opens a list of the apps
answering on a DevTools port on this computer, with *Start an app with a DevTools port*, *Type a
DevTools port*, *Use the page bridge* and *Annotate a web page instead*. The notes are grouped
**Unsent (n)** and **Sent**. A key pressed while the page is busy is answered with a notice.

`PageOverlay` starts its page when the host reports it mounted (`mounted()`, called by
`dialogs.custom` after `showOverlay`), or on the next turn for a host that does not. Dialogs a page
opens as it starts now stack above it, on every page.

**DevTools apps.** `AnnotationCapture.discover()` probes `127.0.0.1` on ports 9222–9230 and any port
used before, reading `/json/version` and `/json/list` with a short timeout. A Node inspector
(`node.js/…`) is skipped. `launchApp(key, path, args)` starts the program (the one inside a macOS
`.app` bundle) with `--remote-debugging-port=<free loopback port>`, waits for its DevTools port, and
attaches. The app keeps running after the capture ends. The loopback-only rule for `cdp` targets
is unchanged.

**Protocol.** Removed: `annotations.queue`, `annotations.dequeue`, `annotations.queued`. Added:
`annotations.pending`, `annotations.markPending`, `annotations.confirmAll`, `annotations.clear`,
`annotations.capture.discover`, `annotations.capture.launch`. `annotations.createAndAct` takes
`save | send`; `annotations.compose` and `annotations.send` take an optional `prompt`. Terminal
routes: `terminal.annotations.confirmAll|clear|discover|launch`; `queue` and `dequeue` are gone.

## Consequences

The App's Annotate panel used `queue`, `fixed` and `createAndAct('queue')` and follows in its own
change. The prompt's Annotations group no longer names `page_notes_mark_fixed`, which changes the
stable prefix once.
