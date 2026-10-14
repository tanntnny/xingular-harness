// Live MCP client sessions: one per (session, connection), opened on first use and closed when
// the session's run ends or the connection changes.
import { Client, SSEClientTransport, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { randomUUID } from 'node:crypto'

import { HarnessError } from '../core/errors'
import { StoredOAuthProvider, type OAuthHost } from './oauth'
import type { HttpConfig, LaunchConfig, StdioConfig } from './types'

interface Live {
  client: Client
  transport: { close(): Promise<void> }
  config: string
}

export const signInRequired = (config: Pick<LaunchConfig, 'name'>): HarnessError => new HarnessError('mcp_unauthorized', `${config.name} needs you to sign in again in Connections.`)
export const isSignInRequired = (error: unknown): boolean => error instanceof UnauthorizedError || (error instanceof HarnessError && error.code === 'mcp_unauthorized')

export class McpManager {
  private readonly sessions = new Map<string, Promise<Live>>()

  constructor(private readonly oauth: OAuthHost) {}

  async close(connectionId?: string, sessionId?: string): Promise<void> {
    const closing = [...this.sessions].filter(([key]) => (!connectionId || key.endsWith(`:${connectionId}`)) && (!sessionId || key.startsWith(`${sessionId}:`)))
    for (const [key] of closing) this.sessions.delete(key)
    await Promise.allSettled(
      closing.map(async ([, session]) => {
        const live = await session
        await live.client.close()
        await live.transport.close()
      })
    )
  }

  /** The client for a connection in one scope, reconnecting when the connection's configuration changed. */
  async client(scope: string, config: LaunchConfig): Promise<Client> {
    const key = `${scope}:${config.id}`
    const fingerprint = JSON.stringify(config)
    const existing = this.sessions.get(key)
    if (existing) {
      const live = await existing.catch(() => null)
      if (live?.config === fingerprint) return live.client
      await live?.client.close().catch(() => undefined)
      this.sessions.delete(key)
    }
    const pending: Promise<Live> = (async () => {
      const { client, transport } = config.transport === 'http' ? await this.connectHttp(config) : await this.connectStdio(config)
      client.onclose = () => {
        if (this.sessions.get(key) === pending) this.sessions.delete(key)
      }
      return { client, transport, config: fingerprint }
    })()
    this.sessions.set(key, pending)
    try {
      return (await pending).client
    } catch (error) {
      this.sessions.delete(key)
      throw error
    }
  }

  private async connectStdio(config: StdioConfig) {
    const client = new Client({ name: 'xagent', version: '0.1.0' })
    const transport = new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd ?? undefined, env: config.env, stderr: 'pipe' })
    try {
      await client.connect(transport, { timeout: 30000 })
    } catch {
      await transport.close()
      throw new HarnessError('mcp_unavailable', `${config.name} could not start or initialize. Check its executable and arguments.`)
    }
    // Servers' diagnostics may contain secrets; do not persist or forward stderr.
    transport.stderr?.on('data', () => undefined)
    return { client, transport }
  }

  private async connectHttp(config: HttpConfig) {
    const authProvider = config.auth === 'oauth' ? new StoredOAuthProvider(this.oauth, config, false) : undefined
    // Without saved tokens the only way forward is the browser, which a session may not open.
    if (authProvider && !(await authProvider.tokens())) throw signInRequired(config)
    const options = { authProvider, requestInit: { headers: config.headers } }
    // Servers that predate Streamable HTTP only answer on SSE.
    for (const Transport of [StreamableHTTPClientTransport, SSEClientTransport]) {
      const client = new Client({ name: 'xagent', version: '0.1.0' })
      const transport = new Transport(new URL(config.url), options)
      try {
        await client.connect(transport, { timeout: 30000 })
        return { client, transport }
      } catch (error) {
        await transport.close().catch(() => undefined)
        if (isSignInRequired(error)) throw signInRequired(config)
      }
    }
    throw new HarnessError('mcp_unavailable', `${config.name} could not be reached. Check its address and credentials.`)
  }

  /** Runs `work` on a connection opened only for it. */
  private async once<T>(prefix: string, config: LaunchConfig, work: (client: Client) => Promise<T>): Promise<T> {
    const scope = `${prefix}-${randomUUID()}`
    try {
      return await work(await this.client(scope, config))
    } finally {
      const key = `${scope}:${config.id}`
      const session = this.sessions.get(key)
      this.sessions.delete(key)
      if (session) await (await session).client.close().catch(() => undefined)
    }
  }

  /** What a connection offers, read on a connection of its own. */
  probe(config: LaunchConfig): Promise<{ serverName: string; tools: unknown[]; vaultId: string | null }> {
    return this.once('probe', config, async (client) => {
      const tools = (await client.listTools()).tools
      let vaultId: string | null = null
      if (tools.some((tool) => tool.name === 'x_workspace_status')) {
        const status = await client.callTool({ name: 'x_workspace_status', arguments: {} })
        const envelope = status.structuredContent as { ok?: boolean; vaultId?: string; error?: { message?: string } } | undefined
        if (!envelope?.ok) throw new HarnessError('mcp_unavailable', envelope?.error?.message ?? 'Workspace vault is not bound.')
        vaultId = envelope.vaultId ?? null
      }
      return { serverName: client.getServerVersion()?.name ?? config.name, tools, vaultId }
    })
  }

  /** One read on a connection of its own, outside any session. */
  readSource(config: LaunchConfig, tool: string, args: Record<string, unknown>): Promise<unknown> {
    return this.once('source', config, (client) => client.callTool({ name: tool, arguments: args }, { timeout: 60000 }))
  }
}
