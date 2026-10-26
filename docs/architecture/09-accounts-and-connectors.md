# 09 Accounts and connectors

## Purpose

**Accounts** are isolated Pi identities: each has its own agent folder, credentials, sessions and
history, so one person can use several providers and subscriptions without them mixing.
**Connectors** (connected apps) are MCP servers a session reaches through a broker, with scoped
access, approval of non-read calls, and redaction. The **Hub** installs exact catalog versions of
skills, prompts, rules and Pi packages.

## Components

| Type / function | Module | Role |
|---|---|---|
| `Accounts` | `accounts/accounts.ts` | Accounts and pools: `resolve`, `context`, `runtime`, `models`, `status`, sign-in (`loginStart`, `loginStatus`, `loginRespond`, `loginCancel`), `setApiKey`, `signOut`, terminal accounting. |
| `isolateProcess`, `ensureSharedDir`, `sharedDir` | `accounts/env.ts` | Isolated launch environments. |
| account store, audit | `accounts/store.ts` | The registry and audit log. |
| `SecretStore`, `secretKey`, `fileSecretStore`, `memorySecretStore` | `accounts/secrets.ts` | Where credentials live (page 01). |
| `ConnectedApps` | `mcp/service.ts` | The broker: `grant`, `session`, `expose`, `tools`, `revokeRun`, `callUnattended`, traces. |
| `Connections` | `mcp/connections.ts` | Saved connections, scopes, secrets, `redactEvent`, `scrub`. |
| `McpManager` | `mcp/manager.ts` | MCP clients. |
| OAuth | `mcp/oauth.ts` | Sign-in; an application's own registered clients (`AppOAuthClients`). |
| `Hub` | `hub/hub.ts`, `hub/schema.ts` | Catalog, preview, install, uninstall, receipts. |

## Contracts

- **Account folder.** Every Pi session gets its account's own agent folder
  (`PI_CODING_AGENT_DIR`) under `<state dir>/accounts/`. Settings, skills, prompts and
  instructions are shared through links to `_shared/pi/`; credentials, sessions and history stay
  in the account's own folder.
- **Resolution.** A new session may name an account, a pool, or neither (the default). Once
  started, it stays on that account.
- **Sign-in progress** lives in the running process only. `accounts.loginStatus` recovers the
  current code or prompt with a revision; it is never written to account files.
- **Broker tools.** `mcp_list_tools` and `mcp_call_tool`. A connection reaches a session only if
  its scope allows the caller and the policy's `connections` keeps it. Calls that are not reads
  are approved through the gate. Each call's redacted result is traced in `mcp-context.json`.
- **`apps.expose(tools)`** offers the application's own tools through the broker, which is how a
  terminal session reaches them.
- **Hub.** `hub.list`, `get`, `preview`, `install`, `uninstall`, `readDocument`. Pi packages need
  an exact npm version or a full Git commit. Documents are saved as inert JSON.

## Invariants

- **INV-ACC-1** Accounts are isolated. A session runs in its account's own Pi folder, never in
  `~/.pi`. The process drops inherited credential variables (`*_API_KEY`, `*_AUTH_TOKEN`,
  `*_OAUTH_TOKEN`, `*_ACCESS_TOKEN`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`)
  before any session starts.
- **INV-ACC-2** An account is never exchanged for another. A pinned session that cannot use its
  account fails. Changing account for a terminal is an explicit person's action that restarts
  the child.
- **INV-ACC-3** The harness never writes a secret to its own files; it asks the `SecretStore`.
  The default file store is owner-only (`0600`).
- **INV-ACC-4** A terminal's `/accounts` goes through the session socket's `accounts.*` calls, and
  every one needs the session's control key. A command the model runs in the shell cannot make
  an account change.
- **INV-MCP-1** Connector secrets live in the `SecretStore`; `connections.json` holds no secret.
  Run events and traces are redacted before they are stored or shown.
- **INV-MCP-2** A session reaches only the connections its scope and the policy allow, and loses
  them when its run ends (`revokeRun`).
- **INV-MCP-3** An application's OAuth client is usable only by a catalog entry it lists, and
  nothing of it is stored.
- **INV-MCP-4** Hub installation grants no attachment, trust, credential or permission. Writes
  are serialized; existing registry files are never overwritten; uninstall removes only the exact
  receipt's resources and revokes its attachment choices.

## Data

```text
<state dir>/accounts/         registry, per-account Pi agent folders, _shared/pi/, audit log, per-account state (health, plan, limits)
<state dir>/secrets.json      default SecretStore (owner-only)
<state dir>/connections.json  connected apps, no secrets
<state dir>/hub/catalog.json  catalog cache
<data root>/hub/              installed documents and provenance
<data root>/runs/<id>/mcp-context.json
```

## Source map

`src/accounts/*.ts`, `src/mcp/*.ts`, `src/hub/*.ts`. Decision:
[ADR-0005](../decisions/ADR-0005-app-provided-oauth-clients.md).

## Account and connector diagnostics

`Accounts.inspect` reads credentials and a non-refreshing Pi model catalogue through a read-only
credential store. It never refreshes OAuth tokens or verifies a key over the network. `/doctor`
labels this local readiness. A selected live model probe sends one synthetic request, caps output
at 64 tokens, and records usage through the normal run writer. It never substitutes an account.
MCP live diagnostics connect and list tools on the selected scoped connector, without calling
connector tools or starting sign-in. Disposable grants and clients are closed afterwards.

## Provider limits (PROP-0042)

A limit reading says what a provider itself reported: a plan window, a credit balance, a rate
limit, or a configured organization limit. Three sources are used, in order:

1. **Response headers** on the account's own model requests. Each account runtime's providers are
   wrapped so `onResponse` sees status and headers; a terminal session's own runtime forwards only
   the limit-bearing headers to the parent over the control-key-protected session socket.
   `usage/limits/normalize.ts` understands `anthropic-ratelimit-*`, Anthropic unified plan windows,
   `x-codex-*` and `x-ratelimit-*`, plus `Retry-After` on a 429. Raw headers are never stored.
2. **The provider's own usage endpoint**, read with `Models.getAuth(provider)` so OAuth refresh
   stays in Pi's serialized credential path: OpenRouter `GET /api/v1/key`, DeepSeek
   `GET /user/balance`, Anthropic's organization `rate_limits` for an admin API key (configured
   limits, not usage), ChatGPT/Codex `GET https://chatgpt.com/backend-api/wham/usage`, and
   OpenCode Go `GET https://opencode.ai/zen/go/v1/usage`. A Codex request carries the account id
   from the access token's JWT claim; an OpenCode Go request carries the account's API key.
   The request is a bounded HTTPS GET that refuses redirects, caps its body, and never puts a
   credential in an error. An endpoint reading replaces every limit for that provider; a header
   reading only merges the windows it saw.
3. **Unavailable**, with a reason. No percentage is invented; local usage is shown instead.

Undocumented endpoints require the usage plugin's `experimentalProbes` setting. Readings are
cached for `refreshMinutes` (default 10) and refreshed on a page open or an explicit refresh, never
by a background timer. They are stored in the account's existing state (`limits`,
`providerLimits`), never in a new file, and no credential is written. A reading carries both `usedPercent` and the additive
`remainingPercent`. The Limits page is a centered dialog: each window is a label and reset line
above a quota-left bar, green at 50% or more left, amber from 20–49%, and red below 20%. It adds
the local seven-day ledger without a label, so a provider's zero reading and this app's own use
are not confused.

## Terminal connection setup

The unified browser exposes existing connection save/test/sign-in/sign-out/remove services through
private terminal controls (PROP-0013). New definitions are saved disabled. Saving does not connect,
sign in or approve tools. Secrets use masked fields and the existing secret store; snapshots omit
saved credential values and scrub connection errors/tool metadata. Hub documents remain inert until
a person explicitly chooses setup and completes the normal validated connection form.
