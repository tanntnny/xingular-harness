---
id: ADR-0005
title: Application-provided OAuth clients for connected apps
status: accepted
created: 2026-10-18
updated: 2026-10-18
supersedes: none
---
# ADR-0005 — Application-provided OAuth clients for connected apps

## Context and decision

Every remote connected app so far authenticated one of two ways: the server registers this app
dynamically (RFC 7591), or the person registers a client with the provider and pastes its ID and
secret into Connections. Google's Workspace MCP servers support neither in practice: they have no
dynamic registration, and requiring every person to create a Google Cloud project before connecting
Gmail is not a product.

A connection's `oauthClient` now has a third value, `app`: **the application supplies the client**.
The host does so through one extension point on the harness:

```ts
export interface AppOAuthClients {
  ids(): string[]
  get(catalogId: string): Promise<{ clientId: string; clientSecret?: string } | null>
}
```

`HarnessOptions.oauthClients` carries it. Only a connection whose `catalogId` appears in `ids()` can
use it — a hand-typed connection, a Hub connector recipe, and a plugin template cannot, because none
of them can name a client the application actually holds. `connections.appClients` reports the ids so
an application can offer only the connectors it can actually sign in for.

The client is resolved inside `Connections.oauthLoad` and placed in the OAuth state as
`staticClient`, exactly where a user-registered client goes. `oauthSave` already strips
`staticClient`, so the client is never written to `connections.json` or the secret store; it is
re-resolved on each load. Refresh tokens continue to be stored per connection.

## Consequences

- The harness learns no product concept: it knows a catalog entry id, a client, and a sign-in. Which
  entries an application can serve is entirely the host's answer.
- A build without a client is a first-class state, not an error: `ids()` is empty, `signIn` refuses
  with "This connector has no app sign-in in this build", and the application hides those catalog
  entries instead of offering a dead end.
- A client secret in a distributed desktop build is extractable, so it is treated as public. The real
  controls stay Google's consent screen, the requested scopes, and the tool approval gate.
- One client can serve several catalog entries (five Google servers, one client). Each entry is still
  its own connection with its own tokens, so signing in to one does not authorize another.
- The per-user path is untouched: `oauthClient: 'user'` still stores a person's own client in
  Keychain, and it remains the only route for providers or accounts an application cannot pre-register
  for.
- Google's Developer Preview terms, app verification and CASA assessment for restricted scopes are
  outside this decision; they decide who can use the shipped client, not how it is delivered.
