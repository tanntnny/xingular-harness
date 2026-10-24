---
id: PROP-0017
title: Page annotations as a Harness capability, captured in the headed browser or a host's web view
status: Implemented
created: 2026-10-23
updated: 2026-10-23
affects: [INV-STO-3, INV-SRV-1, 07-tools-and-gate.md, 10-server-protocol.md, 11-terminal.md, 12-storage.md, 13-world-tools.md, 14-surfaces-and-parity.md]
---

# PROP-0017: Page annotations

Accepted by the user's approval of the parity plan on 2026-10-23 (PROP-0015, ADR-0017). The owner
chose capture through a visible (headed) Harness browser window when only the terminal runs.
Implemented in the working tree on 2026-10-23: `src/annotations/`, the `annotations` world part,
`annotations.*` methods, `/notes` and `/annotate`; spec pages 07, 10, 11, 12, 13 updated. The App
source changes migrate the prior store into Harness and provide the Annotate panel; acceptance of
native WKWebView gestures remains outstanding. The Harness implementation is included in the 4.0.0
candidate.

## Problem

Web annotations exist only in the App (`App/src-tauri/src/browser_annotations/`, FEAT-0016): a
person marks a page, a text range or an element in an App WebKit tab, writes a note, and shares it
with an agent, which reads it with `browser_annotations_list` / `browser_annotations_read`. The
store, the page script and the tools are App code, so the terminal has no annotations (INV-PAR-1).

## Affected rules

- 13-world-tools: "The App owns its shared WebKit browser UI, private/shared tab policy, …" — the
  WebKit capture surface stays with the host; the store, tools and page script move here.
- `INV-STO-3`: new data-root folder `annotations/`.
- `INV-SRV-1`: new method group `annotations`.

## Proposal

### Records

A **note** is `{ id, version, source, target, body, tags, status, author, createdAt, updatedAt,
grants, history }`, the format of the App store, so existing notes import unchanged:

- `source`: `{ url, title, capturedAt }` plus an optional opaque `surface` string from the capturing
  front end.
- `target`: `page`, `text { exact, prefix, suffix, start, end }` (Unicode code points over
  normalised page text), or `element { tag, role, name, text, context, selector }`.
- `status`: `open` or `resolved`. `version` increases on every change; update and delete name the
  version they expect (compare-and-swap). The last 100 change receipts are kept, without earlier
  bodies. At most 10,000 notes.
- `grants`: `{ principal: { sessionId? , agentId? }, binding?: string, grantedAt }[]`. `binding` is
  an opaque host string (the App uses its tab and sharing epoch); the Harness compares it, never
  interprets it. Sharing and revoking are a person's action through the methods below, never a
  model's.

Notes are one JSON file each under `<data root>/annotations/`, written atomically, owned by
`annotations/store.ts`. The store is synchronous, like the Wiki.

### Page script

`annotations/pageScript.js` is the App's page script, moved: plain DOM code with a pull model
(`identity`, `begin`, `capture`, `cancel`, `resolve`, `reveal`). The page never calls out; the
front end polls it. It runs in the page's own script world, as in the App, so a page can tamper
with it: every result is untrusted and validated by the store before it is saved. A host reads the
same source with `annotations.pageScript`.

### Tools

A world part `annotations` (plugin id `annotations`, switchable, on by default) offers two
read-only tools to SDK and terminal sessions:

- `page_notes_list { url?, status?, offset? }` — up to 20 summaries, 12,000 characters total.
- `page_notes_read { id }` — the full note, marked untrusted.

A tool returns only notes granted to the calling session or agent. A binding is the host's handle
for revocation: when what it stands for ends (a tab closes or is shared again), the host calls
`annotations.revokeBinding` and every grant made with it ends. The Harness never interprets a
binding. The part is separate from the browser part, so a host that replaces the browser
(`browser: false`) still has annotations.

### Server methods

Group `annotations`: `list { url?, query?, status?, offset? }`, `read { id }`,
`create { source, target, body, tags }`, `update { id, expectedVersion, patch }`,
`delete { id, expectedVersion }`, `share { id, principal, binding? }`,
`unshare { id, principal }`, `revokeBinding { binding }`, `import { notes }` (keeps ids; used once
by a host migrating its own store), `pageScript` (the page helper's source for a host's web view).

### Terminal capture

- `/annotate [url]` opens a visible capture browser for the terminal session (its own window and
  its own profile, `<state dir>/browser/profiles/person`, separate from the agent's browser),
  navigates when a URL is given, and runs the page script there. The person selects
  text or an element in the Chromium window and presses Capture in the terminal; the terminal pulls
  the selection, asks for a body and tags, and saves the note. `/annotate --page <url>` saves a
  page note without opening a window.
- `/notes` lists notes for the current page or all notes, with search and status filter, and offers
  edit, resolve or reopen, share with this session, unshare, delete and reveal (highlight in the
  headed window; result `matched`, `ambiguous` or `unresolved`).

### Host capture

A host with its own web view (the App's WebKit tabs) runs the same page script there and calls the
same methods. The host keeps its tab and sharing policy and passes it as the grant's binding.

## Alternatives

- **Keep annotations in the App.** Breaks INV-PAR-1.
- **Terminal-only capture from page text and the accessibility snapshot.** The owner chose the
  headed window, which captures exactly what the person selects. Snapshot picking can be added
  later as a fallback.
- **Put the tools in the browser part.** A host that replaces the browser would lose them.

## Consequences

- New data-root folder `annotations/`, new method group, two new model tools.
- The App's store and tools are replaced by Harness calls; its WebKit capture stays.

## Migration

The App imports its existing `<data root>/browser-annotations/*.json` once with
`annotations.import`, keeping ids, then renames the old folder `browser-annotations.migrated`. If
the import fails, nothing is renamed and the App reports it.

## Checks

Store tests ported from the App's `store.rs` tests (compare-and-swap, cap, history, target
validation, code-point offsets); grant tests (an unshared note is invisible, a binding mismatch is
refused); page-script tests; capture and reveal with a fake browser launcher; terminal page model
tests. `npm run typecheck`, `npm test`, `npm run prove`, and the App's checks.
