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

**Inspector, queue and app targets (PROP-0018).**

- **Inspector.** In the page helper's inspector, hovering outlines a component and a click (or a drag over text) opens a comment popover inside the page, with three choices: save, queue for the agent, or send now.
  - A queued note is shared with its session.
  - `annotations/delivery.ts` sends a batch as one instruction, and sends notes the person asked for while the session was busy when its run ends.
  - The agent reports a fix with `page_notes_mark_fixed`, the only page-note tool that writes. It never resolves a note or changes grants.
- **Targets.** Besides the browser window, capture can use an app's own windows:
  - **DevTools port:** an app started with a DevTools port, on a loopback address only. It uses the app's existing windows, routes nothing, and never closes the app.
  - **Page bridge:** a loopback server whose script an app loads while it is developed (`annotations/bridge.ts`), for web views without a DevTools port.
- **Trust.** In Chromium targets the helper runs in an isolated script world, so the page cannot forge a comment. A send from the bridge, or from a host web view without isolation, waits for the person to confirm it.
