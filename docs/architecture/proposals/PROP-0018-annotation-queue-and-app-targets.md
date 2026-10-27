---
id: PROP-0018
title: Inspector-style page notes, a fix queue to the agent, and app windows as capture targets
status: Implemented; queue, three-button popover and page_notes_mark_fixed superseded by PROP-0048
created: 2026-10-23
updated: 2026-10-27
affects: [INV-STO-3, INV-SRV-1, 07-tools-and-gate.md, 10-server-protocol.md, 11-terminal.md, 12-storage.md, 13-world-tools.md, 14-surfaces-and-parity.md]
---

# PROP-0018: Inspector, fix queue and app targets for page notes

> The fix queue, its three-button popover and `page_notes_mark_fixed` were replaced by
> [PROP-0048](PROP-0048-simple-annotate.md): a note is pending or sent, and the popover has Annotate
> and Annotate & send.

Requested by the owner on 2026-10-23. They chose these four things:
- the popover's three choices: Save, Queue, Send now
- the popover drawn inside the page
- Electron over its DevTools port, and real Tauri windows on macOS, as targets
- the Harness and terminal first, then the App pane

Implemented for the Harness and terminal on 2026-10-23 and in the App source on 2026-10-24 (store migration, `page_notes_*` tools, Annotate panel). The Harness implementation is included in the 4.0.0 candidate. Native WKWebView gestures still need acceptance in the running App.

## Problem

Page notes (PROP-0017) take several prompts each. The person picks a kind, confirms in the terminal, types the note in the terminal, then shares it. A note never reaches the agent unless the person asks the agent to read it. Capture works only on http(s) pages, in a new browser context. So a person cannot point at a component of the app they are building, say what to change, and have the agent do it, and they cannot do it at all in a desktop app's own window.

## Affected rules

- `INV-SRV-1`: new methods `annotations.queue`, `dequeue`, `confirm`, `queued`, `createAndAct`, `compose`, `delivered`, `send`, `annotations.capture.*` and `annotations.bridge.start`. All are additive.
- `INV-STO-3`: one new state-directory file, `<state dir>/notes-bridge.json`, which holds the page bridge's port and token. It is owned by `annotations/bridge.ts`.
- 07: a new model tool, `page_notes_mark_fixed`. It is the first page-note tool that writes.
- 13: "Capture happens in the terminal's visible browser or in a host web view" now also covers app windows, either over a loopback DevTools port or through the page bridge.

## Proposal

### Records

A note gains an optional `delivery`:
`{ state: 'queued' | 'sent' | 'fixed', sessionId, queuedAt, autoSend?, confirm?, sentAt?, runId?, fixedAt?, summary? }`.

- `status` (`open` | `resolved`) is unchanged, and only a person resolves a note.
- Queueing a note shares it with that session, because the agent must be able to read what it is asked to fix.
- New history operations: `queue`, `dequeue`, `deliver`, `mark_fixed`.
- A note captured in an app window carries `source.app: { kind: 'cdp' | 'bridge', name }`. Its URL may then also use `file:`, `app:`, `tauri:`, `electron:` or `asset:`, still without credentials. Web notes keep the http(s) rule.

### Inspector and popover

`begin` takes a third kind, `inspect`.
- Hovering draws an outline and a `tag.class W×H` chip.
- A click, or a drag over text, opens a popover beside the target. It has a comment box and three buttons:
  - **Create annotation**: `save`
  - **Ask agent to fix**: `queue`
  - **Proceed now**: `send`
- ⌘/Ctrl+Enter is Proceed now; with Shift it is queue.
- Everything is drawn in a closed shadow root.
- The page never receives the press or click on what is inspected, nor anything typed in the popover.
- Inputs, secrets, `[data-sensitive]` elements, frames, shadow roots and custom elements are never picked, as in PROP-0017. (Open shadow roots and readable custom elements became pickable in [PROP-0038](PROP-0038-annotate-open-shadow-roots.md).)
- The inspector stays on after each comment.
- A new operation, `next`, returns `{ active, documentId, url, title, result }`, one comment at a time.
- `toast` shows a short status in the page.
- The helper's global key moves to `…page.v2`.

### Trust

What the page helper returns is page data. Whether a "Proceed now" goes straight to the agent depends on **where the helper ran**, decided by the Harness:
- **Chromium (the capture browser and DevTools-attached apps):** the helper runs in an isolated script world (`Page.createIsolatedWorld`). The DOM is shared, but the JavaScript globals are not, so the page cannot read or forge results. These results are trusted and sent directly.
- **Page bridge and host web views without isolation:** results are untrusted. A send becomes a queued note with `confirm: true`, which the person confirms in the panel before it goes out.

A host's `annotations.createAndAct` passes `trusted: true` only for comments from its own UI or an isolated world.

### Delivery

`compose(notes)` builds one instruction for a batch:
- It contains each note's id, where it is, the element (tag, role, name, selector, text) or the quoted text, and the person's comment.
- Page-derived text is labelled untrusted and fenced; the comment is in a `comment` fence.
- It asks the agent to call `page_notes_mark_fixed`.
- A batch holds at most 20 notes.

The `NoteDeliveries` service (`annotations/delivery.ts`) handles sending:
- **Terminal session:** the batch goes out as a new run through `TerminalSessions.send`, and the notes become `sent` with that run id. If the session is busy, the notes stay queued with `autoSend`.
- **Host session:** the reply is `{ state: 'host', text, ids }`. The host starts the run (`sessions.run`) and reports it with `annotations.delivered`.
- **When a run ends** (`runs.listen`, after 250 ms), the session's `autoSend` notes go out. Notes still waiting for a person's confirmation are skipped. For a host session, the service emits the notice `annotations.ready`.
- Every change emits `annotations.changed`.

### Model tool

`page_notes_mark_fixed { id, summary }` works only on a note shared with the caller. It sets `delivery.state = 'fixed'` with the summary. It never resolves a note and never changes grants. It is not read-only, so it is unavailable in plan mode.

### Capture targets

`AnnotationCapture` captures in one target per key:
- **`web`:** the visible browser window from PROP-0017. Its helper calls now run in an isolated world.
- **`cdp`:** an app started with a DevTools port, attached with `connectOverCDP` to a loopback address only. It uses the app's own windows, and nothing is routed or opened. Releasing the target disconnects; the app keeps running. The default name is `App at <host:port>`.
- **`bridge`:** a loopback HTTP server (`annotations/bridge.ts`) serves `/page-notes.js?token=…`. That script is the page helper plus a long-poll loop that pulls operations and posts replies.
  - The port and token are kept in `notes-bridge.json`, so the script tag in an app stays valid across restarts.
  - Requests need the token and the host name `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS rebinding.
  - At most 32 windows; a window is dropped after 45 s without a poll.

Methods (`key`, `windows`, `selectWindow`, `inspect`, `stopInspect`, `next`, `toast`) behave the same for all three.

`inspectStep` (`annotations/inspect.ts`) is the one loop step the terminal and hosts share. It:
1. reads the next comment;
2. creates the note with `source.surface` and `source.app`;
3. applies the action with the target's trust;
4. shows a toast in the page.

### Server methods

| Method | Input | Reply |
|---|---|---|
| `annotations.queue` | `{ id, sessionId, expectedVersion?, autoSend? }` | `Note` |
| `annotations.dequeue` | `{ id, expectedVersion? }` | `Note` |
| `annotations.confirm` | `{ id, expectedVersion? }` | `Note` |
| `annotations.queued` | `{ sessionId }` | `{ notes }`, oldest first |
| `annotations.createAndAct` | `{ note, action, sessionId?, trusted? }` | `{ note, send }` |
| `annotations.compose` | `{ sessionId, ids? }` | `{ text, ids }` |
| `annotations.delivered` | `{ ids, sessionId, runId }` | `{ notes }` |
| `annotations.send` | `{ sessionId, ids? }` | `{ state: sent \| busy \| host \| empty, … }` |
| `annotations.capture.attach` | `{ key, kind, endpoint?, name? }` | `{ kind, app, windows, bridge? }` |
| `annotations.capture.target` | `{ key }` | `{ kind, app, inspecting, windows }` |
| `annotations.capture.selectWindow` | `{ key, window }` | `{}` |
| `annotations.capture.open` | `{ key, url? }` | `{ url, title }` |
| `annotations.capture.inspect` / `stopInspect` | `{ key }` | `{ captureId }` / `{}` |
| `annotations.capture.next` | `{ key, sessionId?, surface? }` | `{ active, trusted, app, note, send, message, … }` |
| `annotations.capture.release` | `{ key }` | `{}` |
| `annotations.bridge.start` | `{}` | `{ port, token, scriptUrl, snippet }` |

### Terminal

`/annotate` is now a full-screen pane. The browser window or the app's window is the canvas, and the pane is the panel beside it.

Ways to start it:
- `/annotate [url]`: a web page or dev server
- `/annotate --app <DevTools address | port> [name]`: an app over its DevTools port
- `/annotate --bridge [name]`: shows the script tag to load in the app

The pane:
- The header shows the target, the window, and whether the inspector is on.
- Sections: **Queue (N)**, **Sent and fixed**, and **Saved**.
- Keys:

  | Key | Action |
  |---|---|
  | `i` | inspector on/off |
  | `s` | send the queue, confirming page-origin notes first |
  | `x` | take the selected note out of the queue |
  | `t` | choose a window |
  | `Enter` | note menu: reveal, send, confirm, queue, unqueue, edit, resolve, delete |

- It polls `terminal.annotations.next` every 400 ms while the inspector is on.

New terminal routes: `target`, `attach`, `windows`, `selectWindow`, `inspect`, `stopInspect`, `next`, `queue`, `dequeue`, `confirm`, `send`. They queue and send only to the terminal's own session and need the control key. `/notes` stays the plain list.

## Alternatives

- **The host draws the popover.** The App's native web view covers React content, and each host would build its own. The owner chose in-page drawing.
- **A WebSocket bridge.** It would need a new dependency. Long-polling over plain HTTP is enough for one person's clicks, and `text/plain` posts avoid CORS preflights.
- **Trust whatever the page reports.** A hostile page could start a run with its own text. The isolated world, plus confirmation where isolation is impossible, prevents that.
- **Do nothing.** The owner's request goes unmet.

## Consequences

- **Notes:** the record has a new optional field; older notes read unchanged.
- **Protocol:** additive methods and notices.
- **Hosts:** the App replaces its bottom-strip panel with a pane, and calls `annotations.*`, `annotations.capture.*` for app targets, and `compose`/`delivered` around its own `sessions.run`.
- **Agent tools:** sessions get a third page-note tool.

## Migration

No data migration: `delivery` is optional. The App's PAR-011 migration (`annotations.import`) is unchanged. The bridge settings file is created on first use and can be deleted to get a new port and token.

## Checks

| What | Where |
|---|---|
| Queue, delivery, busy and auto-send, confirmation, host hand-off, mark fixed, app URLs | `annotations/delivery.test.ts` |
| Inspector in a real page: element, text drag, sensitive field refused, Escape, toast, cancel | `annotations/pageScript.test.ts` |
| Isolated world (the page cannot see the helper), reload re-arm, DevTools attach leaves the app running, bridge round-trip as untrusted, stable port and token | `annotations/capture.test.ts` |
| Bridge token, host-name check and relay | `annotations/bridge.test.ts` |
| Pane | `terminal/tui/pages/annotatePage.test.ts` |
| Terminal send and auto-send on run end | `terminal/terminal.test.ts` |
| Host compose and delivered | `npm run prove` |
