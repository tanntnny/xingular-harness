// Device-local connected apps: the saved connections, who may reach each one, how each is
// launched, and what must never be persisted from their results.
import { chmodSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { secretKey, type SecretStore } from '../accounts/secrets'
import type { Bus } from '../core/bus'
import { HarnessError, invalid, notFound } from '../core/errors'
import { newId, readJson, safeId, writeJson } from '../core/fs'
import { findBinary, searchPath } from '../core/path'
import { isDir } from '../memory/store'
import type { RunEvent } from '../sessions/contracts'
import { connectionInputSchema, connectionSchema, type Connection, type ConnectionInput, type LaunchConfig, type Scope } from './types'

const OAUTH_STATE = 'oauth'
const OAUTH_CLIENT_ID = 'oauth_client_id'
const OAUTH_CLIENT_SECRET = 'oauth_client_secret'
const headerItem = (name: string): string => `header:${name}`

/** Remote servers and sign-in pages must use TLS; plain HTTP is only for servers on this machine. */
export function webUrl(text: string | null | undefined): URL | null {
  try {
    const url = new URL(text ?? '')
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    return url.protocol === 'https:' || (url.protocol === 'http:' && loopback) ? url : null
  } catch {
    return null
  }
}

/** Whether a session with this scope may reach the connection. */
export function allowed(connection: Connection, scope: Scope): boolean {
  if (!connection.enabled) return false
  if (scope.agentId && connection.excludedAgentIds.includes(scope.agentId)) return false
  if (scope.projectId && connection.excludedProjectIds.includes(scope.projectId)) return false
  return connection.global || Boolean(scope.agentId && connection.agentIds.includes(scope.agentId)) || Boolean(scope.projectId && connection.projectIds.includes(scope.projectId))
}

/** Gives one agent exactly these connections, leaving every other agent's access as it was. */
export function setAgentScope(all: Connection[], agentId: string, ids: readonly string[]): void {
  for (const connection of all) {
    connection.agentIds = connection.agentIds.filter((id) => id !== agentId)
    connection.excludedAgentIds = connection.excludedAgentIds.filter((id) => id !== agentId)
    if (ids.includes(connection.id)) {
      if (!connection.global) connection.agentIds.push(agentId)
    } else if (connection.global) {
      connection.excludedAgentIds.push(agentId)
    }
  }
}

/** Why these connections cannot be given to a session with this scope, or nothing. */
export function validateScopeIds(all: readonly Connection[], scope: Scope, ids: readonly string[]): void {
  for (const id of ids) {
    const connection = all.find((item) => item.id === id)
    if (!connection) throw notFound('Connection')
    if (!allowed(connection, scope)) throw new HarnessError('required_connections_unavailable', `${connection.name} is disabled or outside your connection scope.`)
  }
}

// ---- Redaction ----------------------------------------------------------------------------------

const SENSITIVE_FIELDS = new Set(['approvaltoken', 'token', 'apikey', 'accesstoken', 'refreshtoken', 'idtoken', 'clientsecret', 'secret', 'password', 'passwd', 'authorization', 'cookie', 'setcookie', 'env', 'credentials', 'locators'])
const SENSITIVE_KEYS = ['approvalToken', 'token', 'apiKey', 'api_key', 'accessToken', 'access_token', 'refreshToken', 'refresh_token', 'clientSecret', 'client_secret', 'password', 'authorization', 'cookie']

function sensitiveField(key: string): boolean {
  return SENSITIVE_FIELDS.has(key.replace(/[^A-Za-z0-9]/g, '').toLowerCase())
}

/** Replaces the value of every `"key": "…"` in text that is not valid JSON (a truncated summary). */
export function redactJsonField(text: string, key: string): string {
  const marker = `"${key}"`
  let output = text
  let offset = 0
  for (;;) {
    const found = output.indexOf(marker, offset)
    if (found < 0) return output
    const start = found + marker.length
    const match = /^\s*:\s*"/.exec(output.slice(start))
    if (!match) {
      offset = start
      continue
    }
    const valueStart = start + match[0].length
    const quote = output.indexOf('"', valueStart)
    const end = quote < 0 ? output.length : quote
    output = `${output.slice(0, valueStart)}[redacted]${output.slice(end)}`
    offset = valueStart + '[redacted]'.length
  }
}

function parsedContainer(text: string): unknown {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Drops credential-like fields from a value, including from JSON carried as text. */
export function scrubSensitive(value: unknown): unknown {
  return scrubWith(value, [])
}

/** `scrubSensitive`, and every one of `secrets` replaced wherever it appears in text. */
export function scrubWith(value: unknown, secrets: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => scrubWith(item, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !sensitiveField(key)).map(([key, item]) => [key, scrubWith(item, secrets)]))
  if (typeof value !== 'string') return value
  let output = value
  for (const secret of secrets) if (secret) output = output.replaceAll(secret, '[redacted]')
  // Text representations of structured previews must not persist approval tokens.
  const parsed = parsedContainer(output)
  if (parsed !== undefined) return JSON.stringify(scrubWith(parsed, secrets))
  // Summaries can contain truncated JSON, which cannot be parsed above.
  for (const key of SENSITIVE_KEYS) output = redactJsonField(output, key)
  return output
}

export function revisionOf(all: readonly Connection[]): unknown[] {
  return all.map((item) => ({ id: item.id, enabled: item.enabled, global: item.global, agents: item.agentIds, projects: item.projectIds, excludedAgents: item.excludedAgentIds, excludedProjects: item.excludedProjectIds, checkedAt: item.checkedAt, error: item.error }))
}

// ---- The store --------------------------------------------------------------------------------

export class Connections {
  private readonly path: string
  /** Every secret value a connection holds, so results can be redacted without waiting on the store. */
  private readonly known = new Map<string, string[]>()

  constructor(
    stateDir: string,
    private readonly secrets: SecretStore,
    private readonly bus: Bus
  ) {
    this.path = join(stateDir, 'connections.json')
  }

  list(): Connection[] {
    const stored = readJson<unknown[]>(this.path) ?? []
    return stored.flatMap((item) => {
      const parsed = connectionSchema.safeParse(item)
      if (!parsed.success) return []
      const connection = parsed.data
      // Records saved before remote servers existed have no `auth`.
      if (!connection.auth) connection.auth = 'none'
      // The preset was saved as "X Workspace" before the product was renamed.
      if (connection.kind === 'workspace' && connection.name === 'X Workspace') connection.name = 'Xingular Workspace'
      return [connection]
    })
  }

  find(id: string): Connection {
    const connection = this.list().find((item) => item.id === id)
    if (!connection) throw notFound('Connection')
    return connection
  }

  forScope(scope: Scope): Connection[] {
    return this.list().filter((connection) => allowed(connection, scope))
  }

  revision(): unknown[] {
    return revisionOf(this.list())
  }

  private write(all: Connection[]): void {
    writeJson(this.path, all)
    try {
      chmodSync(this.path, 0o600)
    } catch {
      // The file was written; a mode that cannot be set is not worth failing the change.
    }
  }

  changed(): void {
    this.bus.emit({ type: 'connections.changed' })
  }

  /** Read-modify-write of one connection. */
  update(id: string, change: (connection: Connection) => void): Connection {
    const all = this.list()
    const connection = all.find((item) => item.id === id)
    if (!connection) throw notFound('Connection')
    change(connection)
    this.write(all)
    return connection
  }

  /** Read-modify-write of every connection. */
  updateAll(change: (all: Connection[]) => void): void {
    const all = this.list()
    change(all)
    this.write(all)
    this.changed()
  }

  private secret(connectionId: string, name: string): Promise<string | null> {
    return this.secrets.get(secretKey(`mcp--${connectionId}`, name))
  }

  private setSecret(connectionId: string, name: string, value: string): Promise<void> {
    return this.secrets.set(secretKey(`mcp--${connectionId}`, name), value)
  }

  private deleteSecret(connectionId: string, name: string): Promise<void> {
    return this.secrets.delete(secretKey(`mcp--${connectionId}`, name))
  }

  /** Everything the secret store holds for a connection: environment and header values, and OAuth credentials. */
  private async secretValues(connection: Connection): Promise<string[]> {
    const values: string[] = []
    for (const key of connection.envKeys) {
      const value = await this.secret(connection.id, key)
      if (value) values.push(value)
    }
    for (const key of connection.headerKeys) {
      const value = await this.secret(connection.id, headerItem(key))
      if (!value) continue
      // "Authorization: Bearer <key>" must not leak the key on its own either.
      const space = value.indexOf(' ')
      if (space >= 0) values.push(value.slice(space + 1).trim())
      values.push(value)
    }
    if (connection.auth === 'oauth') {
      const client = await this.secret(connection.id, OAUTH_CLIENT_SECRET)
      if (client) values.push(client)
      const saved = (parsedContainer((await this.secret(connection.id, OAUTH_STATE)) ?? '') ?? {}) as { tokens?: Record<string, unknown> }
      for (const field of ['access_token', 'refresh_token', 'id_token']) if (typeof saved.tokens?.[field] === 'string') values.push(saved.tokens[field] as string)
    }
    return values.filter(Boolean)
  }

  /** Reloads the secret values used for redaction. Called at start and whenever a connection's secrets change. */
  async refreshSecrets(): Promise<void> {
    const next = new Map<string, string[]>()
    for (const connection of this.list()) next.set(connection.id, await this.secretValues(connection).catch(() => []))
    this.known.clear()
    for (const [id, values] of next) this.known.set(id, values)
  }

  /** A connection's result, safe to persist. */
  scrub(value: unknown, connectionId: string): unknown {
    return scrubWith(value, this.known.get(connectionId) ?? [])
  }

  /** Removes credentials from the evidence a run event carries. */
  redactEvent(event: RunEvent): void {
    if (!event.type.startsWith('tool.') && !['context.snapshot', 'retry.started', 'retry.ended', 'compaction.started', 'compaction.ended'].includes(event.type)) return
    const secrets = [...this.known.values()].flat()
    event.payload = scrubWith(event.payload, secrets)
    if (event.native !== undefined) event.native = scrubWith(event.native, secrets)
  }

  // ---- Launching ----------------------------------------------------------------------------

  async launch(connection: Connection): Promise<LaunchConfig> {
    if (connection.kind === 'remote') {
      const headers: Record<string, string> = {}
      for (const key of connection.headerKeys) {
        const value = await this.secret(connection.id, headerItem(key))
        if (value !== null) headers[key] = value
      }
      return { id: connection.id, name: connection.name, transport: 'http', url: connection.url ?? '', headers, auth: connection.auth as 'none' | 'headers' | 'oauth', scopes: connection.oauthScopes }
    }
    let command = findBinary(connection.command) ?? (isAbsolute(connection.command) ? connection.command : null)
    if (!command) throw new HarnessError('mcp_unavailable', 'MCP executable was not found. Select its absolute path.')
    const env: Record<string, string> = { PATH: searchPath() }
    for (const key of ['HOME', 'TMPDIR', 'LANG']) if (process.env[key]) env[key] = process.env[key]!
    for (const key of connection.envKeys) {
      const value = await this.secret(connection.id, key)
      if (value !== null) env[key] = value
    }
    const args = [...connection.args]
    if (connection.kind === 'workspace') {
      // The first-party launcher is JavaScript; run it on this process's Node even where none is on PATH.
      args.unshift(command)
      command = process.execPath
      if (connection.expectedVaultId && !args.includes('--expected-vault-id')) args.push('--expected-vault-id', connection.expectedVaultId)
    }
    return { id: connection.id, name: connection.name, transport: 'stdio', command, args, cwd: connection.cwd, env }
  }

  // ---- OAuth state --------------------------------------------------------------------------

  private requireOauth(id: string): void {
    if (!this.list().some((item) => item.id === id && item.kind === 'remote' && item.auth === 'oauth')) throw notFound('Connection')
  }

  /** The saved sign-in of a connection, with the client the user registered, if any. */
  async oauthLoad(id: string): Promise<Record<string, unknown>> {
    this.requireOauth(id)
    const saved = (parsedContainer((await this.secret(id, OAUTH_STATE)) ?? '') ?? {}) as Record<string, unknown>
    const state = Array.isArray(saved) ? {} : saved
    const clientId = await this.secret(id, OAUTH_CLIENT_ID)
    if (clientId) {
      const clientSecret = await this.secret(id, OAUTH_CLIENT_SECRET)
      state.staticClient = { client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) }
    }
    return state
  }

  async oauthSave(id: string, state: Record<string, unknown>): Promise<void> {
    this.requireOauth(id)
    const { staticClient: _static, ...saved } = state ?? {}
    await this.setSecret(id, OAUTH_STATE, JSON.stringify(saved))
    await this.refreshSecrets()
  }

  async hasOauthClient(id: string): Promise<boolean> {
    return (await this.secret(id, OAUTH_CLIENT_ID)) !== null
  }

  private forgetSignIn(id: string): Promise<void> {
    return this.deleteSecret(id, OAUTH_STATE)
  }

  // ---- Changes ------------------------------------------------------------------------------

  async save(input: ConnectionInput): Promise<Connection> {
    const parsed = connectionInputSchema.safeParse(input)
    if (!parsed.success) throw invalid('A name, executable, and supported connection kind are required.')
    const { env, removeEnv, headers, removeHeaders, oauthCredentials, ...connection } = parsed.data
    if (!connection.id) connection.id = newId()
    safeId(connection.id)
    const remote = connection.kind === 'remote'
    if (!connection.name.trim() || !['workspace', 'local', 'remote'].includes(connection.kind) || (!remote && !connection.command.trim())) {
      throw invalid('A name, executable, and supported connection kind are required.')
    }
    if (remote) {
      if (!webUrl(connection.url)) throw invalid('Server URL must be an https:// address.')
      if (!['none', 'headers', 'oauth'].includes(connection.auth)) throw invalid('Unsupported sign-in method.')
      if (connection.oauthClient && !['dynamic', 'user'].includes(connection.oauthClient)) throw invalid('Unsupported OAuth client.')
      Object.assign(connection, { command: '', args: [], cwd: null })
      if (connection.auth !== 'oauth') Object.assign(connection, { oauthClient: null, oauthScopes: [] })
    } else {
      Object.assign(connection, { url: null, auth: 'none', oauthClient: null, oauthScopes: [] })
    }
    if (connection.args.some((value) => value.includes('\0')) || connection.command.includes('\0')) throw invalid('Invalid executable or argument.')
    if (connection.cwd && (!isAbsolute(connection.cwd) || !isDir(connection.cwd))) throw invalid('Working directory must be an existing absolute directory.')

    const all = this.list()
    const existing = all.find((item) => item.id === connection.id)
    connection.envKeys = [...(existing?.envKeys ?? [])]
    connection.headerKeys = [...(existing?.headerKeys ?? [])]
    // A sign-in belongs to one server and one client; never carry it to another.
    const sameServer = (existing?.url ?? null) === connection.url && (existing?.auth ?? '') === connection.auth && !oauthCredentials
    if (!sameServer || connection.auth !== 'oauth') await this.forgetSignIn(connection.id)
    connection.authState = connection.auth === 'oauth' ? (sameServer ? (existing?.authState ?? 'signed_out') : 'signed_out') : null
    if (oauthCredentials) {
      if (!oauthCredentials.clientId.trim()) throw invalid('An OAuth client ID is required.')
      await this.setSecret(connection.id, OAUTH_CLIENT_ID, oauthCredentials.clientId.trim())
      if (oauthCredentials.clientSecret) await this.setSecret(connection.id, OAUTH_CLIENT_SECRET, oauthCredentials.clientSecret)
      else await this.deleteSecret(connection.id, OAUTH_CLIENT_SECRET)
    }
    for (const [key, value] of Object.entries(headers ?? {})) {
      if (!/^[A-Za-z0-9_-]+$/.test(key) || /[\r\n\0]/.test(value)) throw invalid('Invalid header name or value.')
      await this.setSecret(connection.id, headerItem(key), value)
      if (!connection.headerKeys.includes(key)) connection.headerKeys.push(key)
    }
    for (const key of removeHeaders ?? []) {
      await this.deleteSecret(connection.id, headerItem(key))
      connection.headerKeys = connection.headerKeys.filter((value) => value !== key)
    }
    for (const [key, value] of Object.entries(env ?? {})) {
      if (!/^[A-Za-z0-9_]+$/.test(key)) throw invalid('Invalid environment variable name.')
      await this.setSecret(connection.id, key, value)
      if (!connection.envKeys.includes(key)) connection.envKeys.push(key)
    }
    for (const key of removeEnv ?? []) {
      await this.deleteSecret(connection.id, key)
      connection.envKeys = connection.envKeys.filter((value) => value !== key)
    }
    Object.assign(connection, { checkedAt: null, tools: [], serverName: null, error: null })
    this.write([...all.filter((item) => item.id !== connection.id), connection])
    await this.refreshSecrets()
    this.changed()
    return connection
  }

  /**
   * Adds one tool to a connection's no-approval list. Unlike a full save this keeps the
   * connection's pending approvals, so the request the user is answering can still be approved.
   */
  allowTool(connectionId: string, tool: string): Connection {
    if (!tool.trim()) throw invalid('A tool is required.')
    if (this.list().some((item) => item.id === connectionId && item.kind === 'workspace')) throw invalid('Changes to Xingular Workspace are approved one at a time.')
    const connection = this.update(connectionId, (item) => {
      if (!item.readTools.includes(tool)) item.readTools.push(tool)
    })
    this.changed()
    return connection
  }

  async remove(connectionId: string): Promise<void> {
    const all = this.list()
    const connection = all.find((item) => item.id === connectionId)
    if (connection) {
      for (const key of connection.envKeys) await this.deleteSecret(connection.id, key)
      for (const key of connection.headerKeys) await this.deleteSecret(connection.id, headerItem(key))
      for (const name of [OAUTH_STATE, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET]) await this.deleteSecret(connection.id, name)
    }
    this.write(all.filter((item) => item.id !== connectionId))
    this.known.delete(connectionId)
    this.changed()
  }

  async signOut(connectionId: string): Promise<Connection> {
    await this.forgetSignIn(connectionId)
    const connection = this.update(connectionId, (item) => {
      if (item.auth === 'oauth') item.authState = 'signed_out'
      Object.assign(item, { checkedAt: null, tools: [], error: null })
    })
    await this.refreshSecrets()
    this.changed()
    return connection
  }
}
