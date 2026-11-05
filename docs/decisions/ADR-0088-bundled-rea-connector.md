# ADR-0088: Bundled REA connector

## Decision

Ship REA as a disabled-by-default built-in plugin with the upstream release's matching skill and MCP runtime. Its local connector is a virtual broker connection, not a saved connection or a Pi-owned client. The existing plugin attachment controls its scope. A run must also have both the connector and the skill contribution in its frozen capability set; current scope and host policy are rechecked for every call and after approval. Unknown REA operations require approval, and read-only sessions cannot call them. Plan mode continues to refuse the generic MCP call tool.

The REA plugin's bounded call deadline defaults to 450 seconds and can be set in plugin settings. Saved MCP connections default to 60 seconds and accept 1–1,800 seconds. A client timeout has an unknown outcome and is not automatically retried. Neither deadline changes the server's own provider limits.

## Consequences

The skill and runtime share one pinned `rea-agents` version. Plugin enablement neither starts the server immediately nor grants approvals. The server is launched lazily, and a run ending or the plugin changing closes its client. REA's Node support is stricter than the Harness minimum; an unsupported runtime or missing package is reported rather than upgraded automatically. The runtime is a pinned optional dependency so an unsupported Node version can still install the Harness; npm may omit it on such a runtime. Its third-party notices are distributed with the Harness. Native analysis providers remain independently installed and configured.
