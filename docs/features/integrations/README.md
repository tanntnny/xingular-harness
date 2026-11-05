# Integrations

The Harness stays application-neutral. An embedding application contributes its own data and
capabilities through generic extension points; plugins and connected apps are loaded and governed by
the Harness.

## Application extension points

The Harness has seven extension points:

1. **Prompt sections** — application context added to the compiled prompt.
2. **Tool providers** — application tools offered to eligible sessions.
3. **Tool policy** — per-call scope, authorization, approvals, and connector limits.
4. **Secret store** — application-chosen credential storage.
5. **Directory** — names for opaque application identifiers.
6. **Plugin descriptions** — attribution for tools, sections, and groups supplied by a plugin.
7. **RefineHost** — isolated workspaces, sessions, and deliverables for refinement.

The server protocol provides equivalents for non-Node hosts except `RefineHost`, which is Node-only
today.

## Plugins and capabilities

Plugins can contribute instructions, skills, commands, tools, connections, extension code, and themes.
The Harness selects what loads, keeps capabilities scoped to callers, and requires trust for
executable plugin code. Enabling a plugin does not by itself grant tool permission; calls still pass
the gate.

## Connected apps and Hub

Connected apps use an MCP broker with scoped session access, approval for non-read calls, and
redaction of stored traces. Each saved connection has a tool-call timeout of 1–1,800 seconds
(default 60), editable from the terminal Connections form. A timeout can leave an unknown outcome;
the broker does not retry the operation.

The optional built-in **Reverse engineer anything** plugin ships the REA 6.8.0 skill and, when
available for the installation's Node runtime, its matching local MCP server. Open `/plugins`,
select it and enable it for the desired scope; use its setting to change the 450-second default
call deadline. Its operations need approval, and generic MCP calls remain unavailable in plan mode.
The pinned optional dependency requires Node 22.23.4+, 24.22.1+, or 26.12.1+; other Harness-supported
Node versions can install the Harness without it, and REA reports why it cannot start. REA's
native analysis providers are separate prerequisites. REA runs as a local process with the Harness
user's operating-system permissions; the native Bash workspace sandbox does not confine this MCP
server. A server timeout or disconnect does not prove the requested operation stopped; inspect its
state before retrying. The Hub installs exact catalog versions of skills, prompts, rules, and
Pi packages. Installation does not automatically enable, trust, or authorize the installed resources.

## Further reading

- [01 Extension points](../../architecture/01-extension-points.md) — the application-to-Harness contract.
- [06 Plugins and capabilities](../../architecture/06-plugins-and-capabilities.md) — loading, trust, and frozen capability sets.
- [07 Tools and the gate](../../architecture/07-tools-and-gate.md) — per-call authorization.
- [09 Accounts and connectors](../../architecture/09-accounts-and-connectors.md) — secrets, connected apps, OAuth, and Hub.
