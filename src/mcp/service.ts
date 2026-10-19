// Connected apps as sessions use them: which connections a session may reach, the two broker
// tools every such session gets, approval of anything that is not a read, and a redacted record
// of what each call returned.
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type { SecretStore } from '../accounts/secrets'
import type { Bus } from '../core/bus'
import type { HarnessEnv } from '../core/env'
import { HarnessError, invalid, notFound } from '../core/errors'
import { newId, now, readJson, writeJson } from '../core/fs'
import { charCount, takeChars } from '../core/text'
import type { CapabilitySet } from '../capabilities/types'
import type { CallerContext } from '../core/caller'
import type { ToolPolicy } from '../sessions/policy'
import type { ActiveRun, RunRegistry } from '../sessions/registry'
import { findRun, runDir } from '../sessions/runStore'
import type { SessionBroker } from '../sessions/sessions'
import type { ToolSession, ToolSpec } from '../tools/types'
import { allowed, Connections, webUrl } from './connections'
import { isSignInRequired, McpManager, signInRequired } from './manager'
import { signIn, type OAuthHost } from './oauth'
import type { AppOAuthClients, Connection, HttpConfig, LaunchConfig, McpSource, McpTrace } from './types'

/** A session's access to the broker. A terminal session presents `token`; an SDK session holds the object. */
export interface BrokerSession {
  token: string
  sessionId: string
  runId: string | null
  caller: CallerContext
  /** Only reads are permitted. */
  readOnly: boolean
  depth: number
  /** The run's immutable tool and connector set. */
  capabilities?: CapabilitySet
}

export interface BrokerTool {
  name: string
  description?: string
  inputSchema?: unknown
}

/** Tools the embedding application offers through the broker, beside connected apps. */
export interface BrokeredTools {
  list(session: BrokerSession): Promise<BrokerTool[]>
  has(name: string): boolean
  /** The tool's result as the application returns it: text, `{ text, image? }`, or structured data. */
  call(session: BrokerSession, name: string, args: Record<string, unknown>): Promise<unknown>
  /** Changes whenever the offered tools may have changed. */
  revision?(session: BrokerSession): Promise<unknown>
  /** A sentence added to the discovery tool's description, e.g. where the application lists the rest of its tools. */
  discoveryNote?: string
}

interface ListedTool extends BrokerTool {
  connectionId: string
  tool: string
  origin?: 'app'
}

const TOOL_SUMMARY_CHARS = 160

/**
 * A tool listing a model can scan: a name and one line each. Input schemas are the bulk of a
 * discovery reply, so they come back for one named tool at a time.
 */
export function compactTools<T extends BrokerTool>(tools: readonly T[], tool?: string): Array<Omit<T, 'inputSchema'> | T> {
  if (tool) return tools.filter((entry) => entry.name === tool)
  return tools.map(({ inputSchema: _schema, ...entry }) => ({
    ...entry,
    ...(entry.description && entry.description.length > TOOL_SUMMARY_CHARS ? { description: `${entry.description.slice(0, TOOL_SUMMARY_CHARS).trimEnd()}…` } : {})
  })) as Array<Omit<T, 'inputSchema'>>
}

/** Most tools one listing returns. A server with hundreds of tools would otherwise make every discovery call a very large input. */
export const TOOL_PAGE = 40

/**
 * One page of a tool listing: names and summaries only, optionally filtered by a
 * case-insensitive `query` over name and description. `more` and `nextOffset` appear when
 * entries remain.
 */
export function pageTools<T extends BrokerTool>(tools: readonly T[], options: { query?: string; offset?: number; limit?: number } = {}) {
  const query = options.query?.trim().toLowerCase()
  const matching = query ? tools.filter((tool) => tool.name.toLowerCase().includes(query) || (tool.description ?? '').toLowerCase().includes(query)) : tools
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? TOOL_PAGE), 100))
  const page = compactTools(matching.slice(offset, offset + limit))
  const next = offset + page.length
  return { tools: page, total: matching.length, ...(next < matching.length ? { more: matching.length - next, nextOffset: next } : {}) }
}

const WORKSPACE_READS = new Set([
  'x_workspace_status', 'x_workspace_context', 'x_workspace_search', 'x_workspace_note_list', 'x_workspace_note_read', 'x_workspace_project_list', 'x_workspace_project_get',
  'x_workspace_task_list', 'x_workspace_task_get', 'x_workspace_milestone_list', 'x_workspace_milestone_get', 'x_workspace_update_list', 'x_workspace_update_get',
  'x_workspace_meeting_list', 'x_workspace_meeting_get', 'x_workspace_resource_list', 'x_workspace_resource_get', 'x_workspace_resource_preview'
])

interface Proposal {
  runId: string
  sessionId: string
  connectionId: string
  data: unknown
  expiresAt: string
}

interface AuthorizedCall {
  session: BrokerSession
  connection: Connection
  runId: string
}

export interface ConnectedAppsOptions {
  env: HarnessEnv
  stateDir: string
  secrets: SecretStore
  bus: Bus
  runs: RunRegistry
  policy: ToolPolicy
  /** The application's own registered OAuth clients, if it has any. */
  oauthClients?: AppOAuthClients
}

/** The scope a plugin hook's connections are opened under: they belong to no session. */
const UNATTENDED_SCOPE = 'plugin-hooks'

export class ConnectedApps implements SessionBroker {
  readonly toolNames = ['mcp_list_tools', 'mcp_call_tool'] as const
  readonly connections: Connections
  private readonly manager: McpManager
  private readonly oauth: OAuthHost
  private readonly grants = new Map<string, BrokerSession>()
  private readonly proposals = new Map<string, Proposal>()
  private readonly calls = new Map<string, AuthorizedCall>()
  private brokered: BrokeredTools | null = null

  constructor(private readonly options: ConnectedAppsOptions) {
    this.connections = new Connections(options.stateDir, options.secrets, options.bus, () => options.env.root, options.oauthClients ?? null)
    this.oauth = {
      clientName: options.env.productName,
      load: (id) => this.connections.oauthLoad(id),
      save: (id, state) => this.connections.oauthSave(id, state),
      openUrl: (url) => {
        if (!webUrl(url)) throw invalid('The sign-in page must be an https:// address.')
        // The application shows the page; the harness never opens a browser by itself.
        options.bus.emit({ type: 'connections.openUrl', url })
      }
    }
    this.manager = new McpManager(this.oauth)
  }

  /** Loads what is needed to redact results. Call once before sessions start. */
  start(): Promise<void> {
    return this.connections.refreshSecrets()
  }

  /** Lets the application offer its own tools through `mcp_list_tools` and `mcp_call_tool`. */
  expose(tools: BrokeredTools): void {
    this.brokered = tools
  }

  // ---- Grants -----------------------------------------------------------------------------

  /** Gives a session access to the broker. The token is what a process outside the harness presents. */
  grant(input: Omit<BrokerSession, 'token'>): BrokerSession {
    const session: BrokerSession = { ...input, token: `${newId()}${newId()}` }
    this.grants.set(session.token, session)
    return session
  }

  session(token: string): BrokerSession {
    const session = this.grants.get(token)
    if (!session) throw new HarnessError('mcp_unauthorized', 'This MCP session is no longer authorized.')
    return session
  }

  revokeSession(sessionId: string): void {
    for (const [token, session] of this.grants) if (session.sessionId === sessionId) this.grants.delete(token)
    for (const [key, proposal] of this.proposals) if (proposal.sessionId === sessionId) this.proposals.delete(key)
  }

  /** A run ended: its grants, previews, and open client sessions go with it. */
  revokeRun(runId: string, sessionId: string): void {
    for (const [token, session] of this.grants) if (session.runId === runId) this.grants.delete(token)
    for (const [key, proposal] of this.proposals) if (proposal.runId === runId) this.proposals.delete(key)
    void this.manager.close(undefined, sessionId)
  }

  private activeRun(session: BrokerSession): ActiveRun {
    const run = (session.runId ? this.options.runs.active(session.runId) : null) ?? this.options.runs.activeForSession(session.sessionId)
    if (!run) throw new HarnessError('run_not_active', 'The requesting run has ended.')
    return run
  }

  private valid(session: BrokerSession): void {
    if (this.grants.get(session.token) !== session) throw new HarnessError('mcp_unauthorized', 'This MCP session is no longer authorized.')
  }

  // ---- What a session may reach ---------------------------------------------------------------

  private async reachable(session: BrokerSession): Promise<Connection[]> {
    const scoped = this.connections.forScope({ agentId: session.caller.agentId, projectId: session.caller.projectId })
    const frozen = session.capabilities ? scoped.filter((connection) => session.capabilities!.connectors.includes(connection.id)) : scoped
    const policy = this.options.policy.connections
    // Nothing to narrow: the application is not asked.
    if (!policy || !frozen.length) return frozen
    const ids = await policy({ sessionId: session.sessionId, runId: session.runId, caller: session.caller, connectionIds: frozen.map((connection) => connection.id) })
    return frozen.filter((connection) => ids.includes(connection.id))
  }

  /** The application's tools and every reachable connection's tools, with the connections that could not be read. */
  async list(session: BrokerSession): Promise<{ tools: ListedTool[]; errors: { connection: string; message: string }[] }> {
    const own = (await this.brokered?.list(session)) ?? []
    const discovered = await Promise.all(
      (await this.reachable(session)).map(async (connection) => {
        const tools: ListedTool[] = []
        let config: LaunchConfig | null = null
        try {
          config = await this.connections.launch(connection)
          const client = await this.manager.client(session.sessionId, config)
          for (const tool of (await client.listTools({}, { timeout: 15000 })).tools) {
            const alias = `mcp_${createHash('sha256').update(`${connection.id}:${tool.name}`).digest('hex').slice(0, 12)}_${tool.name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40)}`
            tools.push({ name: alias, description: `${connection.name}: ${tool.description ?? tool.name}`, inputSchema: tool.inputSchema, connectionId: connection.id, tool: tool.name })
          }
          if (client.getServerCapabilities()?.resources) {
            for (const operation of ['list', 'read'] as const) {
              tools.push({
                name: `mcp_${connection.id.replace(/-/g, '').slice(0, 12)}_resources_${operation}`,
                description: `${connection.name}: ${operation} MCP resources`,
                inputSchema: { type: 'object', properties: operation === 'read' ? { uri: { type: 'string' } } : {}, ...(operation === 'read' ? { required: ['uri'] } : {}) },
                connectionId: connection.id,
                tool: `resources/${operation}`
              })
            }
          }
          return { tools, errors: [] }
        } catch (error) {
          const unauthorized = isSignInRequired(error)
          const message = unauthorized ? signInRequired(connection).message : `${connection.name} could not load its tools. Check its scope in Capability → Connectors.`
          if (unauthorized) await this.manager.close(connection.id, session.sessionId)
          this.connectionFailed(connection.id, unauthorized)
          return { tools: [], errors: [{ connection: connection.name, message }] }
        }
      })
    )
    return {
      tools: [...own.map((tool): ListedTool => ({ ...tool, origin: 'app', connectionId: '__app__', tool: tool.name })), ...discovered.flatMap((entry) => entry.tools)],
      errors: discovered.flatMap((entry) => entry.errors)
    }
  }

  private connectionFailed(connectionId: string, unauthorized: boolean): void {
    try {
      this.connections.update(connectionId, (item) => {
        if (item.auth === 'oauth' && unauthorized) {
          item.authState = 'expired'
          item.error = `${item.name} needs you to sign in again.`
        } else if (item.kind === 'remote') {
          item.error = `${item.name} could not load its tools. Check its address and sign-in, then test or reconnect.`
        } else {
          item.error = `${item.name} could not load its tools. Check its executable and arguments, then test or reconnect.`
        }
      })
      this.connections.changed()
    } catch {
      // The connection was removed while it was being read.
    }
  }

  // ---- Calling ------------------------------------------------------------------------------

  /** Runs one tool by the name `list` gave it. */
  async invoke(session: BrokerSession, alias: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.brokered?.has(alias)) {
      const result = await this.brokered.call(session, alias, args)
      const output = result as { text?: string; image?: { data: string; mimeType: string } } | null
      return {
        content: [{ type: 'text', text: output?.text ?? (typeof result === 'string' ? result : JSON.stringify(result)) }, ...(output?.image ? [{ type: 'image', ...output.image }] : [])],
        ...(!output?.image && result && typeof result === 'object' ? { structuredContent: Array.isArray(result) ? { result } : result } : {})
      }
    }
    const tool = (await this.list(session)).tools.find((candidate) => candidate.name === alias)
    if (!tool) throw new HarnessError('mcp_tool_unavailable', 'This MCP tool is unavailable or its connection was disabled.')
    const toolCallId = randomUUID()
    const config = await this.authorize(session, tool.connectionId, tool.tool, args, toolCallId)
    try {
      const client = await this.manager.client(session.sessionId, config)
      const result = tool.tool === 'resources/list' ? await client.listResources() : tool.tool === 'resources/read' ? await client.readResource({ uri: String(args.uri) }) : await client.callTool({ name: tool.tool, arguments: args }, { timeout: 60000 })
      this.completed(toolCallId, tool.tool, { result })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'MCP call failed'
      this.completed(toolCallId, tool.tool, { error: tool.tool === 'x_workspace_mutation_apply' ? 'Workspace apply did not return a confirmed result. Do not retry automatically; read the affected record to verify its state.' : message })
      throw error
    }
  }

  /** Checks scope, asks for approval when the call is not a read, and returns how to reach the connection. */
  private async authorize(session: BrokerSession, connectionId: string, tool: string, args: Record<string, unknown>, toolCallId: string): Promise<LaunchConfig> {
    const run = this.activeRun(session)
    const record = findRun(this.options.env.root, run.runId)
    if (record) {
      const scope = await this.options.policy.scope?.({ run: record, caller: session.caller, tool: 'connected_app', args })
      if (scope && scope.automatic && !scope.allowed) throw new HarnessError('outside_work_scope', scope.reason ?? 'Outside the approved work scope.')
    }
    const denied = (): HarnessError => new HarnessError('mcp_access_denied', 'This connection is disabled or unavailable to this agent.')
    const connection = (await this.reachable(session)).find((item) => item.id === connectionId)
    if (!connection) throw denied()
    const workspace = connection.kind === 'workspace'
    const preview = workspace && tool === 'x_workspace_mutation_preview'
    const apply = workspace && tool === 'x_workspace_mutation_apply'
    const isRead = (workspace && WORKSPACE_READS.has(tool)) || (!apply && !preview && connection.readTools.includes(tool))
    if (session.readOnly && !isRead) throw new HarnessError('mcp_read_only', 'This session only permits reads from connected apps.')
    let proposal: unknown
    if (apply) {
      const approvalToken = typeof args.approvalToken === 'string' ? args.approvalToken : ''
      const saved = this.proposals.get(approvalToken)
      this.proposals.delete(approvalToken)
      if (!saved) throw new HarnessError('mcp_preview_required', 'Create a fresh preview in this run before applying.')
      if (saved.sessionId !== session.sessionId || saved.runId !== run.runId || saved.connectionId !== connectionId || saved.expiresAt <= now()) throw new HarnessError('mcp_preview_required', 'This preview belongs to another run or has expired.')
      proposal = saved.data
    }
    run.emit('tool.started', { toolCallId, name: tool, summary: connection.name })
    if (!isRead && !preview) {
      const action = JSON.stringify(proposal ?? this.connections.scrub(args, connection.id), null, 2)
      const decision = await run.requestApproval({ requestId: `mcp-${newId()}`, target: connection.name, action: `${tool}\n${action}`, standing: 'switch', timeoutMs: 300_000 })
      if (decision !== 'approved') {
        run.emit('tool.completed', { toolCallId, name: tool, ok: false })
        throw new HarnessError('mcp_denied', 'The user denied the MCP operation or its approval expired.')
      }
    }
    // Access may have been revoked, or the run ended, while the request was waiting.
    const current = (await this.reachable(session)).find((item) => item.id === connectionId)
    if (!current) throw new HarnessError('mcp_access_denied', 'Connection access was revoked while waiting.')
    this.valid(session)
    this.activeRun(session)
    this.calls.set(toolCallId, { session, connection: current, runId: run.runId })
    return this.connections.launch(current)
  }

  /** Records what an authorized call returned: a redacted trace with its sources, and the tool's outcome. */
  private completed(toolCallId: string, tool: string, outcome: { result?: unknown; error?: string }): void {
    const call = this.calls.get(toolCallId)
    if (!call) return
    this.calls.delete(toolCallId)
    const { connection, session, runId } = call
    const result = (outcome.result ?? null) as { structuredContent?: { data?: { approvalToken?: unknown; expiresAt?: unknown }; truncated?: unknown }; isError?: unknown } | null
    const structured = result?.structuredContent
    const live = this.grants.get(session.token) === session && this.options.runs.active(runId) !== null
    if (tool === 'x_workspace_mutation_preview' && live && typeof structured?.data?.approvalToken === 'string') {
      this.proposals.set(structured.data.approvalToken, { runId, sessionId: session.sessionId, connectionId: connection.id, data: this.connections.scrub(structured.data, connection.id), expiresAt: typeof structured.data.expiresAt === 'string' ? structured.data.expiresAt : '' })
    }
    const ok = outcome.error === undefined && result?.isError !== true
    const cleaned = this.connections.scrub(result, connection.id) as { structuredContent?: { sources?: unknown } } | null
    const raw = outcome.error === undefined ? JSON.stringify(cleaned) : String(this.connections.scrub(outcome.error, connection.id))
    const found = cleaned?.structuredContent?.sources
    const sources: McpSource[] = (Array.isArray(found) ? found : [])
      .flatMap((source: Record<string, unknown> | null) => {
        if (!source || typeof source.id !== 'string' || typeof source.title !== 'string' || typeof source.uri !== 'string') return []
        const value: McpSource = { id: source.id, title: source.title, uri: source.uri, path: typeof source.path === 'string' ? source.path : null }
        for (const field of ['revision', 'excerpt', 'projectId'] as const) if (typeof source[field] === 'string') value[field] = takeChars(source[field] as string, 2000)
        return [value]
      })
      .slice(0, 100)
    const trace: McpTrace = { id: toolCallId, connectionId: connection.id, connectionName: connection.name, tool, at: now(), ok, summary: tool, result: takeChars(raw, 24000), sources, truncated: charCount(raw) > 24000 || structured?.truncated === true }
    try {
      const file = join(runDir(this.options.env.root, runId), 'mcp-context.json')
      writeJson(file, [...(readJson<McpTrace[]>(file) ?? []), trace])
    } catch {
      // The call happened; a trace that cannot be written does not undo it.
    }
    this.options.runs.active(runId)?.emit('tool.completed', { toolCallId, name: tool, ok })
  }

  /** What a run retrieved from connected apps, in order. */
  runContext(runId: string): McpTrace[] {
    return readJson<McpTrace[]>(join(runDir(this.options.env.root, runId), 'mcp-context.json')) ?? []
  }

  /** Changes whenever what a session can discover may have changed. */
  async revision(session: BrokerSession): Promise<unknown> {
    return { connections: this.connections.revision(), tools: (await this.brokered?.revision?.(session)) ?? null }
  }

  // ---- The two tools a session gets -------------------------------------------------------------

  tools(session: ToolSession, options: { readOnly: boolean }): ToolSpec[] {
    const granted = this.grant({ sessionId: session.run.sessionId, runId: session.run.runId, caller: session.caller, readOnly: options.readOnly, depth: session.depth, capabilities: session.capabilities })
    return this.brokerTools(granted)
  }

  /** `mcp_list_tools` and `mcp_call_tool` bound to a granted session. */
  brokerTools(session: BrokerSession): ToolSpec[] {
    return [
      {
        name: 'mcp_list_tools',
        label: 'App and connector tools',
        description: `Discover enabled ${this.options.env.productName} app operations and connector tools by name. Pass tool to get one tool with its input schema.${this.brokered?.discoveryNote ? ` ${this.brokered.discoveryNote}` : ''}`,
        parameters: (Type) =>
          Type.Object({
            tool: Type.Optional(Type.String({ description: 'One tool name, to get its input schema.' })),
            query: Type.Optional(Type.String({ description: 'Only tools whose name or description contains this text.' })),
            offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Where to continue a long list (nextOffset from the previous page).' }))
          }),
        execute: async (input) => {
          const listed = await this.list(session)
          const wanted = typeof input.tool === 'string' && input.tool ? input.tool : undefined
          if (wanted) return JSON.stringify({ ...listed, tools: compactTools(listed.tools, wanted) })
          const page = pageTools(listed.tools, { query: typeof input.query === 'string' ? input.query : undefined, offset: typeof input.offset === 'number' ? input.offset : undefined })
          return JSON.stringify({ ...listed, ...page, note: `Names and summaries only. Call mcp_list_tools with tool for the input schema before the first call to that tool.${page.more ? ' More tools match: pass offset, and query to narrow the list.' : ''}` })
        }
      },
      {
        name: 'mcp_call_tool',
        label: 'Use connector',
        description: 'Invoke an enabled app or connector tool returned by mcp_list_tools. Current settings are checked on every call. Changes require approval.',
        parameters: (Type) => Type.Object({ name: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) }),
        execute: async (input) => JSON.stringify(await this.invoke(session, String(input.name), (input.arguments ?? {}) as Record<string, unknown>))
      }
    ]
  }

  // ---- What a person does on the Connections screen ---------------------------------------------

  async save(input: Parameters<Connections['save']>[0]): Promise<Connection> {
    const connection = await this.connections.save(input)
    this.cancelConnection(connection.id)
    return connection
  }

  async remove(connectionId: string): Promise<void> {
    await this.connections.remove(connectionId)
    this.cancelConnection(connectionId)
  }

  private cancelConnection(connectionId: string): void {
    for (const [key, proposal] of this.proposals) if (proposal.connectionId === connectionId) this.proposals.delete(key)
    void this.manager.close(connectionId)
  }

  /** Connects once and records what the server offers, or why it could not be reached. */
  async test(connectionId: string): Promise<Connection> {
    const connection = this.connections.find(connectionId)
    let probed: Awaited<ReturnType<McpManager['probe']>> | null = null
    let failure: unknown = null
    try {
      probed = await this.manager.probe(await this.connections.launch(connection))
    } catch (error) {
      failure = error
    }
    if (JSON.stringify(this.connections.find(connectionId)) !== JSON.stringify(connection)) throw new HarnessError('mcp_config_changed', 'Connection changed during its test. Test the saved connection again.')
    const updated = this.connections.update(connectionId, (item) => {
      item.checkedAt = now()
      if (probed) {
        item.serverName = probed.serverName
        item.tools = probed.tools
        item.error = null
        if (item.kind === 'workspace' && !item.expectedVaultId) item.expectedVaultId = probed.vaultId
      } else {
        if (isSignInRequired(failure) && item.auth === 'oauth' && item.authState === 'signed_in') item.authState = 'expired'
        item.error = failure instanceof Error ? failure.message : String(failure)
        item.tools = []
      }
    })
    this.connections.changed()
    return updated
  }

  /** Signs in with the provider in a browser. Only a person starts this; a session that finds an expired sign-in reports it. */
  async signIn(connectionId: string): Promise<Connection> {
    const connection = this.connections.find(connectionId)
    if (connection.kind !== 'remote' || connection.auth !== 'oauth') throw invalid('This connection does not use browser sign-in.')
    if (!(await this.connections.hasSignInClient(connection))) {
      throw invalid(connection.oauthClient === 'app'
        ? 'This connector has no app sign-in in this build. Enable its OAuth client or use your own client.'
        : 'Add your OAuth client ID before signing in.')
    }
    await signIn(this.oauth, (await this.connections.launch(connection)) as HttpConfig)
    const updated = this.connections.update(connectionId, (item) => Object.assign(item, { authState: 'signed_in', error: null }))
    await this.manager.close(connectionId)
    this.connections.changed()
    return updated
  }

  /** The catalog entries this application can sign in for, so a client need not be added by hand. */
  appClients(): { catalogIds: string[] } {
    return { catalogIds: this.connections.availableAppClients() }
  }

  async signOut(connectionId: string): Promise<Connection> {
    const updated = await this.connections.signOut(connectionId)
    this.cancelConnection(connectionId)
    return updated
  }

  /** Reads one retrieved source again from the Xingular Workspace connection it came from. */
  async refreshSource(runId: string, traceId: string, sourceUri: string): Promise<unknown> {
    const trace = this.runContext(runId).find((entry) => entry.id === traceId)
    if (!trace) throw notFound('Retrieved context')
    const source = trace.sources.find((entry) => entry.uri === sourceUri)
    if (!source) throw notFound('Source')
    const connection = this.connections.list().find((item) => item.enabled && item.kind === 'workspace' && item.id === trace.connectionId)
    if (!connection) throw new HarnessError('mcp_access_denied', 'Enable the original Xingular Workspace connection to refresh this source.')
    const kind = sourceUri.split('/')[3] ?? ''
    const [tool, args]: [string, Record<string, unknown>] = kind.startsWith('note')
      ? ['x_workspace_note_read', { path: source.path ?? source.id }]
      : kind.startsWith('task')
        ? ['x_workspace_task_get', { id: source.id }]
        : kind.startsWith('project')
          ? ['x_workspace_project_get', { id: source.id }]
          : kind.startsWith('resource')
            ? ['x_workspace_resource_get', { id: source.id }]
            : ['x_workspace_context', { query: source.title || source.id }]
    return this.connections.scrub(await this.manager.readSource(await this.connections.launch(connection), tool, args), connection.id)
  }

  /** Gives one agent exactly these connections, if its creator may reach each of them. */
  setAgentScope(creator: { agentId?: string | null; projectId?: string | null }, agentId: string, ids: readonly string[]): Connection[] {
    const all = this.connections.list()
    for (const id of ids) {
      const connection = all.find((item) => item.id === id)
      if (!connection) throw notFound('Connection')
      if (!allowed(connection, creator)) throw new HarnessError('required_connections_unavailable', `${connection.name} is disabled or outside your connection scope.`)
    }
    return this.connections.setAgentScope(agentId, ids)
  }

  /**
   * A call with no session and nobody to ask, made by a plugin's hook. It reaches a connection
   * only when it is on for everyone, and a tool only when a person marked it to run without asking.
   */
  async callUnattended(reference: string, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const connection = this.connections.list().find((item) => item.id === reference || item.name === reference)
    if (!connection || !allowed(connection, {})) throw new HarnessError('mcp_access_denied', `There is no connected app called "${reference}" that is on for everyone.`)
    // A change to the first-party workspace is previewed and approved by a person, never run from a hook.
    if (!connection.readTools.includes(tool) || tool.startsWith('x_workspace_mutation')) {
      throw new HarnessError('mcp_denied', `${connection.name} asks before running "${tool}". Mark it to run without asking in the connection's settings to let a plugin use it.`)
    }
    const client = await this.manager.client(UNATTENDED_SCOPE, await this.connections.launch(connection))
    return client.callTool({ name: tool, arguments: args }, { timeout: 60000 })
  }

  /** Switches one saved connection on or off for everyone, one agent, or one project. */
  attach(connectionId: string, scope: { agentId?: string | null; projectId?: string | null }, on: boolean): void {
    const connection = this.connections.find(connectionId)
    if (!connection.enabled) throw invalid(`${connection.name} is switched off. Switch it on in its own settings first.`)
    this.connections.setScope(connectionId, scope, on)
  }

  /** Forgets an agent that no longer exists. */
  removeAgentScope(agentId: string): void {
    this.connections.removeAgentScope(agentId)
  }

  async close(): Promise<void> {
    await this.manager.close(undefined, UNATTENDED_SCOPE).catch(() => undefined)
    await this.manager.close()
  }
}
