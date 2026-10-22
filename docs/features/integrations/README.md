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
redaction of stored traces. The Hub installs exact catalog versions of skills, prompts, rules, and
Pi packages. Installation does not automatically enable, trust, or authorize the installed resources.

## Further reading

- [01 Extension points](../../architecture/01-extension-points.md) — the application-to-Harness contract.
- [06 Plugins and capabilities](../../architecture/06-plugins-and-capabilities.md) — loading, trust, and frozen capability sets.
- [07 Tools and the gate](../../architecture/07-tools-and-gate.md) — per-call authorization.
- [09 Accounts and connectors](../../architecture/09-accounts-and-connectors.md) — secrets, connected apps, OAuth, and Hub.
