# 13 World tools

The Foundation owns the generic isolated browser engine, per-session contexts and profiles,
network policy, and lifecycle. Built-in World plugins contribute the user-facing web search/page
tools, browser tools and annotations through the existing tool-provider surface. Every tool passes
the same capability and policy gate. Web requests use the public-address guard; browser requests
use the device-local private-address setting. Read page content is untrusted. Sending, purchasing,
deleting, changing accounts and granting access require explicit human approval. Sensitive fields
are not filled by the agent.

The App owns its shared WebKit browser UI, private/shared tab policy, selected-file uploads,
windows and the native computer bridge. These application objects do not enter the Harness.
Other hosts may add backend capabilities and diagnostics through ToolProvider or WorldPart.

Browser configuration is device-local. User-configured CDP attachment is explicit; diagnostics
never attach to it. Doctor browser probes instead use disposable headless profiles and an offline
synthetic page. Their input runs only after live-check confirmation, and their resources are
released on completion, timeout or cancellation. Computer interaction needs a host-provided
isolated surface; without one it is blocked.

## Approved-window screenshot contract

`computer/screenshot.ts` defines an opt-in host provider adapter for `computer_screenshot`.
The backend must capture exactly one currently approved window, excluding the desktop, other windows
and overlays even when they overlap, and refuse if it cannot guarantee that scope. It must not
fall back to a display capture. Coordinates supplied to a host's related interaction tools, if any,
are relative to the returned image pixels. The tool goes through the ordinary provider and gate,
returns an image to the model, and is not plan-mode safe by default. Image content is untrusted.
The contract itself does not prove that a host implements these requirements. In particular, the
existing macOS host capture has not yet adopted this contract and captures a display; it must not
be represented as approved-window-only capture. The standalone terminal has no capture backend.


## Shared browser contract and native WebKit limits (PROP-0040)

`browser/contracts.ts` owns the backend-neutral names and input schemas for `browser_*` tools;
providers adapt those definitions rather than inventing host-specific selectors. The isolated Harness
backend supports accessibility snapshots and snapshot-scoped refs. A native WebKit host backend
supports navigation, tab management, visible-text reads, page screenshots and page-level scrolling
without a ref. It does not support accessibility snapshots, snapshot refs or ref-based
click/type/select/scroll/screenshot, browser waits or keyboard presses. Native page screenshot
implementation and authorization checks are present, but live host capture acceptance remains open.

For an unsupported operation the native provider returns an explicit `browser_unsupported` refusal
with “Nothing was done”; it never treats a snapshot ref as a selector and never silently switches to
the isolated browser. The isolated Harness browser is an independent backend, not an automatic
fallback for the native provider. A host plugin's `surfaces` description labels that fallback and its
limits; it does not assert full browser parity.

Plugin ownership and the Foundation boundary are recorded in PROP-0012, ADR-0014 and PROP-0020.
World providers are assembled through `BuiltinPluginRegistry`; no eighth extension point is added.

An embedding host may set `browser: false` to disable the generic backend and its plugin
descriptor before supplying its own browser tool provider. The App uses this option for its
shared-tab browser, so matching tool names never silently select the wrong backend.

## Page notes (PROP-0017)

The `annotations` world part offers `page_notes_list` and `page_notes_read`, read-only, to SDK and
terminal sessions. It is separate from the browser part, so a host that sets `browser: false` keeps
it. A tool returns only notes a person shared with the calling session or agent; quoted page text
and element names are marked untrusted. Capture happens in a visible capture browser in the
terminal, or in a host's own web view running the same page helper (`annotations.pageScript`).

**Inspector, sending and app targets (PROP-0018, PROP-0048).**

- **Inspector.** In the page helper's inspector, hovering outlines a component and a click (or a drag over text) opens a comment popover inside the page, with two choices: Annotate and Annotate & send.
  - With a session, every note is shared with it at once and is pending (unsent) until sent.
  - `annotations/delivery.ts` sends all of a session's pending notes as one message, with the
    person's request last when given, and sends notes held back while the session was busy when its
    run ends, trying again while the session still answers busy.
  - The page-note tools are read-only. Only the person resolves a note.
- **Targets.** Element targets prefer semantic role/name/text. A visually empty element may still be
  annotated when it has a specific CSS selector (ID, test ID, classes, and a structural path when
  needed); bare tag selectors are not enough. Reveal checks for one live match and preserves any
  captured semantic/context evidence, otherwise reporting ambiguous or unresolved. Text annotations
  continue to use quote plus context, not screen coordinates.
- Besides the browser window, capture can use an app's own windows:
  - **DevTools port:** an app started with a DevTools port, on a loopback address only. It uses the app's existing windows, routes nothing, and never closes the app. `discover` probes loopback ports 9222–9230 and ports used before (a Node inspector is skipped); `launchApp` starts a program (the one inside a macOS `.app`) with `--remote-debugging-port` on a free loopback port and attaches. A started app keeps running.
  - **Page bridge:** a loopback server whose script an app loads while it is developed (`annotations/bridge.ts`), for web views without a DevTools port.
- **Web components (PROP-0038).** The helper walks the composed tree: open shadow roots and slotted content can be picked, selected and revealed, and such targets carry `tree: 'composed'`. Targets without it resolve by the document-only rules as before. Closed shadow roots and frames stay out of reach, and the inspector says why it refuses something.
- **Trust.** In Chromium targets the helper runs in an isolated script world, so the page cannot forge a comment. A send from the bridge, or from a host web view without isolation, waits for the person to confirm it.
