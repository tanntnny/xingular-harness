// Connected apps: MCP servers the user added. A connection is device-local; its secrets
// (environment values, request headers, OAuth tokens and client) are in the secret store,
// never in `connections.json`.
import { z } from 'zod'

/** Loopback address every OAuth sign-in returns to. Pre-registered clients must list it exactly. */
export const MCP_OAUTH_PORT = 47823
export const MCP_OAUTH_REDIRECT_URL = `http://127.0.0.1:${MCP_OAUTH_PORT}/oauth/callback`

/**
 * The application's own registered OAuth clients, by catalog entry. A client supplied here is
 * used for that sign-in only and is never written to the connection or the secret store.
 */
export interface AppOAuthClients {
  /** The catalog entries this application can sign in for. */
  ids(): string[]
  get(catalogId: string): Promise<{ clientId: string; clientSecret?: string } | null>
}

/** Stable attachment key for a connected app's capability switch. */
export const connectionCapabilityId = (id: string): string => `connected-apps/connection/${id}`

export const connectionSchema = z.object({
  id: z.string().default(''),
  name: z.string().default(''),
  /** `workspace` (the first-party Xingular Workspace server), `local` (a command), or `remote` (Streamable HTTP). */
  kind: z.string().default(''),
  command: z.string().default(''),
  args: z.array(z.string()).default([]),
  cwd: z.string().nullable().default(null),
  envKeys: z.array(z.string()).default([]),
  enabled: z.boolean().default(false),
  /** Available to every agent and project, except those excluded. */
  global: z.boolean().default(false),
  agentIds: z.array(z.string()).default([]),
  projectIds: z.array(z.string()).default([]),
  excludedAgentIds: z.array(z.string()).default([]),
  excludedProjectIds: z.array(z.string()).default([]),
  /** Tools that run without asking. */
  readTools: z.array(z.string()).default([]),
  expectedVaultId: z.string().nullable().default(null),
  checkedAt: z.string().nullable().default(null),
  serverName: z.string().nullable().default(null),
  tools: z.array(z.unknown()).default([]),
  error: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  /** `none`, `headers`, or `oauth`. */
  auth: z.string().default(''),
  headerKeys: z.array(z.string()).default([]),
  oauthClient: z.string().nullable().default(null),
  oauthScopes: z.array(z.string()).default([]),
  authState: z.string().nullable().default(null),
  catalogId: z.string().nullable().default(null)
})
export type Connection = z.infer<typeof connectionSchema>

export const connectionInputSchema = connectionSchema.extend({
  env: z.record(z.string(), z.string()).nullish(),
  removeEnv: z.array(z.string()).nullish(),
  headers: z.record(z.string(), z.string()).nullish(),
  removeHeaders: z.array(z.string()).nullish(),
  /** A client registered by the user with the provider; replaces any saved sign-in. */
  oauthCredentials: z.object({ clientId: z.string(), clientSecret: z.string() }).nullish()
})
export type ConnectionInput = z.input<typeof connectionInputSchema>

export interface StdioConfig {
  id: string
  name: string
  transport: 'stdio'
  command: string
  args: string[]
  cwd: string | null
  env: Record<string, string>
}

export interface HttpConfig {
  id: string
  name: string
  transport: 'http'
  url: string
  headers: Record<string, string>
  auth: 'none' | 'headers' | 'oauth'
  scopes: string[]
}

/** What it takes to reach a server: a process to start, or an address and its credentials. */
export type LaunchConfig = StdioConfig | HttpConfig

/** Who a session is, for deciding which connections it may reach. */
export interface Scope {
  agentId?: string | null
  projectId?: string | null
}

export interface McpSource {
  id: string
  title: string
  uri: string
  path?: string | null
  revision?: string
  excerpt?: string
  projectId?: string
}

/** One connected-app call a run made, kept in `runs/<id>/mcp-context.json`. */
export interface McpTrace {
  id: string
  connectionId: string
  connectionName: string
  tool: string
  at: string
  ok: boolean
  summary: string
  result: string
  sources: McpSource[]
  truncated: boolean
}
