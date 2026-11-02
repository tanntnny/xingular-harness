---
id: ADR-0082
title: Connected Brave browser backend
status: accepted
created: 2026-11-20
updated: 2026-11-20
related: [STUDY-0008, PROP-0040, INV-PAR-1, INV-PAR-2]
supersedes: null
superseded_by: null
---

# ADR-0082 — Connected Brave browser backend

## Context

The isolated Chromium browser cannot use the person's existing sign-in. The App's WebKit tabs are
host-owned, have a different profile lifecycle, and do not implement snapshot-scoped ref actions.
The person asked to choose between an isolated browser and their existing signed-in Brave profile,
with no automatic switch if the chosen backend disconnects.

## Decision

Add an opt-in Brave backend through an unpacked Manifest V3 extension. The extension uses
`chrome.debugger` to adopt existing normal tabs, and the Harness adapts the extension to the shared
`BrowserToolSession` and `browser_*` schemas. The extension is loaded manually and pairs with the
Harness over an authenticated loopback bridge. Do not enable remote debugging on the person's
profile and do not require Native Messaging. Pairing validates the extension origin; subsequent
service-worker calls require the bearer token because the browser may omit Origin on those requests,
and any supplied mismatched Origin is rejected.

Browser backend selection is device-local. A project, variant or page cannot enable Brave. A person
must explicitly choose Brave, pair the extension with a short-lived code, and allow each exact
origin from the extension popup. Chrome host grants can cover every port on a host, so the extension
also records the exact scheme, host and port and checks that allow list before exposing a tab.
Incognito is disabled. The extension does
not request history or cookie permissions and does not export cookies; a signed-in page remains
signed in because it uses the existing profile. The extension's `debugger` permission is broad and
must be disclosed before the person selects Brave.

While connected and permitted, the page shows **“Xingular Agent is on this site”**, with Pause and
Stop controls and a brief pulse at the most recent click. Pause refuses new calls but lets an action
already in flight finish. Stop revokes the pairing, rejects pending calls, clears the badge and closes
the bridge. Normal Harness shutdown closes the bridge but keeps the pairing so the extension can
reconnect. A lost or paused connection refuses calls; it never selects another browser. A timed-out
call reports that its outcome is unknown and requires a fresh snapshot before retry.

The shared browser gate remains authoritative: snapshot refs are invalidated when page state or the
debugger attachment changes; sensitive fields are refused; consequential actions require fresh
human approval and are revalidated; actions require an attended run; page content remains untrusted.
The Brave tool list does not include the App-specific `browser_upload`. WebKit remains an independent
backend with its existing narrower capabilities.

## Consequences

- Harness and terminal settings can select isolated or Brave, pair, inspect status and stop the
  connection. Hosts may disable the generic browser provider with `browser: false` and retain the
  Harness bridge through `HarnessOptions.browserExtension`.
- The App keeps WebKit as its native backend and obtains shared Harness browser tools only when
  Brave is selected. The App's connected-apps broker does not expose duplicate browser tools in
  Brave mode.
- Pairing state lives in owner-only `<state dir>/browser/extension-bridge.json`; backend and
  network settings remain in `<state dir>/browser.json`.
- The extension requires manual loading and site permissions. It does not provide a remote browser
  service, history, cookie export, file uploads or general DevTools console/network access.
- D-25 remains open for selector-based operations in the App's WebKit Rust implementation and its
  App-only upload contract. D-26 is partly resolved: Brave implements the shared ref tools, but the
  App's Rust capability response is not yet backend-aware.
- The opt-in live acceptance in `src/browser/extension/brave-live.acceptance.test.ts` passed with a
disposable Brave profile and a loopback fixture. It covers pairing, exact-origin gating, snapshots,
actions, pause/stop and disconnect refusal; it does not exercise Chrome's optional-host grant
prompt for a non-loopback site. Use only disposable profiles for runtime verification; never use the
everyday profile.
