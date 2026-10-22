# 13 World tools

The foundation supplies generic web and isolated browser tools through the existing tool-provider
surface. Web requests use the public-address guard. Each browser session owns its context and
profile; its tools pass the same capability and policy gate as other tools. Read page content is
untrusted. Sending, purchasing, deleting, changing accounts and granting access require explicit
human approval. Sensitive fields are not filled by the agent.

The App owns its shared WebKit browser UI, private/shared tab policy, selected-file uploads,
windows and the native computer bridge. These application objects do not enter the Harness.
Other hosts may add backend capabilities and diagnostics through ToolProvider or WorldPart.

Browser configuration is device-local. User-configured CDP attachment is explicit; diagnostics
never attach to it. Doctor browser probes instead use disposable headless profiles and an offline
synthetic page. Their input runs only after live-check confirmation, and their resources are
released on completion, timeout or cancellation. Computer interaction needs a host-provided
isolated surface; without one it is blocked.

Ownership is recorded in PROP-0012 and ADR-0014. No eighth extension point is added.

An embedding host may set `browser: false` to disable the generic backend and its plugin
descriptor before supplying its own browser tool provider. The App uses this option for its
shared-tab browser, so matching tool names never silently select the wrong backend.
