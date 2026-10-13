import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import type { RunEvent } from '../sessions/contracts'
import type { ToolPolicy } from '../sessions/policy'
import type { PiSessionLike } from '../sessions/runner'
import { allowed, redactJsonField, scrubSensitive, scrubWith, setAgentScope, validateScopeIds, webUrl } from './connections'
import type { BrokerSession } from './service'
import { compactTools, pageTools } from './service'
import { connectionSchema, type Connection } from './types'

const fixture = join(dirname(fileURLToPath(import.meta.url)), '../../tests/mcp-fixture.mjs')
const connection = (fields: Partial<Connection>): Connection => connectionSchema.parse(fields)
const scope = { agentId: 'agent-test', projectId: 'project-test' }

describe('who may reach a connection', () => {
  it('global access applies to future agents and honors overrides', () => {
    const item = connection({ enabled: true, global: true })
    expect(allowed(item, scope)).toBe(true)
    expect(allowed({ ...item, excludedAgentIds: ['agent-test'] }, scope)).toBe(false)
    expect(allowed({ ...item, excludedProjectIds: ['project-test'] }, scope)).toBe(false)
    expect(allowed({ ...item, enabled: false }, scope)).toBe(false)
  })

  it('local access requires an explicit agent or project', () => {
    const item = connection({ enabled: true })
    expect(allowed(item, scope)).toBe(false)
    expect(allowed({ ...item, agentIds: ['agent-test'] }, scope)).toBe(true)
    expect(allowed({ ...item, projectIds: ['project-test'] }, scope)).toBe(true)
  })

  it('giving an agent its connections is exact and preserves other scopes', () => {
    const creator = { agentId: 'creator' }
    const all = [
      connection({ id: 'global', name: 'Global', enabled: true, global: true, agentIds: ['existing'] }),
      connection({ id: 'scoped', name: 'Scoped', enabled: true, agentIds: ['creator', 'existing'] }),
      connection({ id: 'private', name: 'Private', enabled: true, agentIds: ['existing'] })
    ]
    expect(() => validateScopeIds(all, creator, ['scoped'])).not.toThrow()
    expect(() => validateScopeIds(all, creator, ['private'])).toThrow('outside your connection scope')
    expect(() => validateScopeIds(all, creator, ['missing'])).toThrow()
    setAgentScope(all, 'helper', ['scoped'])
    const helper = { agentId: 'helper' }
    expect(all.map((item) => allowed(item, helper))).toEqual([false, true, false])
    expect(all.every((item) => item.agentIds.includes('existing'))).toBe(true)
    expect([allowed(all[0], creator), allowed(all[1], creator)]).toEqual([true, true])
    all[1].enabled = false
    expect(() => validateScopeIds(all, creator, ['scoped'])).toThrow()
    setAgentScope(all, 'helper', [])
    expect(all.some((item) => allowed(item, helper))).toBe(false)
  })

  it('remote servers and sign-in pages must use TLS unless local', () => {
    for (const accepted of ['https://mcp.linear.app/mcp', 'http://127.0.0.1:8080/mcp', 'http://localhost:8080/mcp']) expect(webUrl(accepted)).not.toBeNull()
    for (const rejected of ['http://mcp.example.com/mcp', 'file:///etc/passwd', 'javascript:alert(1)', 'mcp.linear.app']) expect(webUrl(rejected)).toBeNull()
  })

  it('connections saved before remote servers still load', () => {
    const saved = connection(JSON.parse('{"id":"old","name":"Old","kind":"local","command":"server","args":[],"envKeys":["KEY"],"enabled":true}'))
    expect([saved.url, saved.authState, saved.catalogId, saved.headerKeys.length, saved.auth, saved.envKeys]).toEqual([null, null, null, 0, '', ['KEY']])
  })
})

describe('what is never persisted', () => {
  it('drops tokens and stored secrets, including from JSON carried as text', () => {
    const result = JSON.stringify(scrubWith({ structuredContent: { approvalToken: 'preview-secret', data: 'fixture-secret' }, content: [{ text: '{"approvalToken":"preview-secret","data":"fixture-secret"}' }] }, ['fixture-secret']))
    expect(result).not.toContain('preview-secret')
    expect(result).not.toContain('fixture-secret')
    expect(result).toContain('[redacted]')
    expect(JSON.stringify(scrubWith('{"approvalToken":"truncated-preview', []))).not.toContain('truncated-preview')
    const evidence = JSON.stringify(scrubSensitive({ apiKey: 'top-secret', Authorization: 'Bearer private', nested: { password: 'not saved', query: 'keep this' } }))
    for (const leaked of ['top-secret', 'private', 'not saved']) expect(evidence).not.toContain(leaked)
    expect(evidence).toContain('keep this')
    expect(JSON.stringify(scrubSensitive('{"password":"cut-off-secret'))).not.toContain('cut-off-secret')
    expect(redactJsonField('{"token" : "abc", "other": "token"}', 'token')).toBe('{"token" : "[redacted]", "other": "token"}')
  })

  it('lists tools as names and summaries, a page at a time', () => {
    const tools = Array.from({ length: 45 }, (_, index) => ({ name: `tool_${index}`, description: index === 3 ? 'x'.repeat(300) : `Tool ${index}`, inputSchema: { type: 'object' } }))
    expect(compactTools(tools, 'tool_3')).toEqual([tools[3]])
    const page = pageTools(tools)
    expect([page.tools.length, page.total, page.more, page.nextOffset]).toEqual([40, 45, 5, 40])
    expect(page.tools[0]).not.toHaveProperty('inputSchema')
    expect((page.tools[3].description ?? '').length).toBeLessThanOrEqual(161)
    expect(pageTools(tools, { query: 'TOOL_44' }).tools.map((tool) => tool.name)).toEqual(['tool_44'])
  })
})

// ---- A real server, a real run -------------------------------------------------------------

const open: Harness[] = []
const servers: Array<() => void> = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
  for (const close of servers.splice(0)) close()
})

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

/** A harness with one live run whose session keeps going until the test releases it. */
async function live(policy: ToolPolicy = {}) {
  let release: () => void = () => undefined
  const stateDir = mkdtempSync(join(tmpdir(), 'harness-mcp-state-'))
  const secrets = memorySecretStore()
  const session: PiSessionLike = { sessionId: 'native', subscribe: () => () => undefined, prompt: () => new Promise<void>((resolve) => (release = resolve)), sendCustomMessage: async () => undefined, abort: async () => release(), dispose: () => undefined }
  const harness = createHarness({ dataRoot: mkdtempSync(join(tmpdir(), 'harness-mcp-data-')), stateDir, secrets, policy, sessionFactory: async () => session })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')
  const events: RunEvent[] = []
  harness.runs.listen((event) => void events.push(event))
  await harness.sessions.run({ run: { id: 'run-1', sessionId: 'session-1' }, cwd: harness.env.root, sessionDir: join(harness.env.root, 'history'), text: 'go', caller: { agentId: 'agent-1', actor: 'Chat' }, tools: { allow: [] } })
  const granted: BrokerSession = harness.apps.grant({ sessionId: 'session-1', runId: 'run-1', caller: { agentId: 'agent-1', actor: 'Chat' }, readOnly: false, depth: 0 })
  return { harness, events, granted, secrets, release: () => release() }
}

const local = { name: 'Fixture', kind: 'local', command: process.execPath, args: [fixture], enabled: true, global: true, env: { MCP_FIXTURE_VALUE: 'personal task outside repo' } }

describe('connected apps for a session', () => {
  it('discovers and calls a real stdio server, asking before a change and recording a redacted trace', async () => {
    const { harness, events, granted, secrets } = await live()
    const saved = await harness.apps.save({ ...local, readTools: ['read_record'] })
    expect(saved.envKeys).toEqual(['MCP_FIXTURE_VALUE'])
    expect(JSON.stringify(harness.apps.connections.list())).not.toContain('personal task')
    expect([...secrets.values.keys()]).toEqual([`mcp--${saved.id}/MCP_FIXTURE_VALUE`])

    const tested = await harness.apps.test(saved.id)
    expect([tested.serverName, tested.error, tested.tools.length]).toEqual(['fixture', null, 2])

    const listed = await harness.apps.list(granted)
    expect(listed.errors).toEqual([])
    const read = listed.tools.find((tool) => tool.tool === 'read_record')!
    expect(read.name).toMatch(/^mcp_[0-9a-f]{12}_read_record$/)
    // A read runs without asking; its result is stored with the connection's secret value removed.
    expect(await harness.apps.invoke(granted, read.name, {})).toMatchObject({ content: [{ type: 'text', text: 'personal task outside repo' }] })
    const trace = harness.apps.runContext('run-1')
    expect(trace).toHaveLength(1)
    expect(trace[0]).toMatchObject({ connectionName: 'Fixture', tool: 'read_record', ok: true })
    expect(trace[0].result).toContain('[redacted]')
    expect(trace[0].result).not.toContain('personal task')
    expect(events.filter((event) => event.type === 'approval.requested')).toHaveLength(0)

    // A change waits for a person, and does not run when they say no.
    const change = listed.tools.find((tool) => tool.tool === 'change_record')!
    const denied = harness.apps.invoke(granted, change.name, {})
    await tick(200)
    const request = events.find((event) => event.type === 'approval.requested')!.payload as { approvalId: string; target: string; action: string }
    expect(request.approvalId.startsWith('mcp-')).toBe(true)
    expect([request.target, request.action]).toEqual(['Fixture', 'change_record\n{}'])
    harness.runs.resolveApproval('run-1', request.approvalId, 'denied')
    await expect(denied).rejects.toMatchObject({ code: 'mcp_denied' })
    expect(harness.apps.runContext('run-1')).toHaveLength(1)

    // "Always allow" for one tool keeps the connection as it was tested.
    expect(harness.apps.connections.allowTool(saved.id, 'change_record').readTools).toEqual(['read_record', 'change_record'])
    expect(await harness.apps.invoke(granted, change.name, {})).toMatchObject({ content: [{ type: 'text', text: 'changed' }] })
    expect(harness.apps.connections.find(saved.id).checkedAt).toBe(tested.checkedAt)
  })

  it('offers the two broker tools and the application\'s own tools through them', async () => {
    const { harness, granted } = await live()
    harness.apps.expose({ list: async () => [{ name: 'get_capabilities', description: 'What you can do', inputSchema: { type: 'object' } }], has: (name) => name === 'get_capabilities', call: async () => ({ tools: ['a'] }) })
    const [list, call] = harness.apps.brokerTools(granted)
    expect([list.name, call.name]).toEqual(['mcp_list_tools', 'mcp_call_tool'])
    const listed = JSON.parse((await list.execute({})) as string)
    expect(listed.tools).toEqual([{ name: 'get_capabilities', description: 'What you can do', origin: 'app', connectionId: '__app__', tool: 'get_capabilities' }])
    expect(listed.note).toContain('Names and summaries only')
    expect(JSON.parse((await list.execute({ tool: 'get_capabilities' })) as string).tools[0].inputSchema).toEqual({ type: 'object' })
    expect(JSON.parse((await call.execute({ name: 'get_capabilities', arguments: {} })) as string)).toEqual({ content: [{ type: 'text', text: '{"tools":["a"]}' }], structuredContent: { tools: ['a'] } })
  })

  it('reports an unavailable executable without exposing diagnostics, and marks the connection', async () => {
    const { harness, granted } = await live()
    const saved = await harness.apps.save({ ...local, command: '/missing/mcp-fixture' })
    const result = await harness.apps.list(granted)
    expect(result.tools).toEqual([])
    expect(result.errors[0].message).toContain('Capability → Connectors')
    expect(harness.apps.connections.find(saved.id).error).toContain('executable and arguments')
  })

  it('lets the application narrow what a session reaches, and nothing is reachable once the run ends', async () => {
    let allow = true
    const { harness, granted, release } = await live({ connections: async ({ connectionIds }) => (allow ? connectionIds : []) })
    await harness.apps.save({ ...local, readTools: ['read_record'] })
    expect((await harness.apps.list(granted)).tools).toHaveLength(2)
    allow = false
    expect((await harness.apps.list(granted)).tools).toEqual([])
    allow = true
    const read = (await harness.apps.list(granted)).tools.find((tool) => tool.tool === 'read_record')!
    release()
    await tick()
    expect(() => harness.apps.session(granted.token)).toThrow('no longer authorized')
    await expect(harness.apps.invoke(granted, read.name, {})).rejects.toMatchObject({ code: 'run_not_active' })
  })

  it('a read-only session may only read', async () => {
    const { harness } = await live()
    await harness.apps.save({ ...local, readTools: ['read_record'] })
    const readOnly = harness.apps.grant({ sessionId: 'session-1', runId: 'run-1', caller: { agentId: 'agent-1', actor: 'Chat' }, readOnly: true, depth: 0 })
    const tools = (await harness.apps.list(readOnly)).tools
    await expect(harness.apps.invoke(readOnly, tools.find((tool) => tool.tool === 'change_record')!.name, {})).rejects.toMatchObject({ code: 'mcp_read_only' })
    expect(await harness.apps.invoke(readOnly, tools.find((tool) => tool.tool === 'read_record')!.name, {})).toMatchObject({ content: [{ type: 'text' }] })
  })
})

/** A stateless Streamable HTTP server; `status` makes it refuse every request instead. */
async function remoteFixture(status?: number) {
  const requests: Array<Record<string, unknown>> = []
  const server = createServer(async (request, response) => {
    requests.push(request.headers)
    if (status || request.method !== 'POST') return void response.writeHead(status ?? 405).end()
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const mcp = new McpServer({ name: 'remote-fixture', version: '1' })
    mcp.registerTool('read_record', { description: 'Read remote record' }, async () => ({ content: [{ type: 'text', text: 'remote record' }] }))
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await mcp.connect(transport)
    const reply = await transport.handleRequest(new Request(`http://127.0.0.1${request.url}`, { method: 'POST', headers: request.headers as Record<string, string>, body: Buffer.concat(chunks) }))
    response.writeHead(reply.status, Object.fromEntries(reply.headers)).end(Buffer.from(await reply.arrayBuffer()))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(() => {
    server.close()
    server.closeAllConnections()
  })
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, requests }
}

describe('remote connected apps', () => {
  const remote = { name: 'Remote', kind: 'remote', enabled: true, global: true, readTools: ['read_record'] }

  it('reaches a Streamable HTTP server with its saved headers, which stay out of the file', async () => {
    const server = await remoteFixture()
    const { harness, granted } = await live()
    const saved = await harness.apps.save({ ...remote, url: server.url, auth: 'headers', headers: { 'X-Api-Key': 'fixture-key' } })
    expect([saved.headerKeys, saved.command, saved.authState]).toEqual([['X-Api-Key'], '', null])
    const read = (await harness.apps.list(granted)).tools.find((tool) => tool.tool === 'read_record')!
    expect(await harness.apps.invoke(granted, read.name, {})).toMatchObject({ content: [{ type: 'text', text: 'remote record' }] })
    expect(server.requests.every((headers) => headers['x-api-key'] === 'fixture-key')).toBe(true)
    expect(JSON.stringify(harness.apps.connections.list())).not.toContain('fixture-key')
  })

  it('reports an unreachable server without naming its credentials', async () => {
    const server = await remoteFixture(500)
    const { harness, granted } = await live()
    const saved = await harness.apps.save({ ...remote, url: server.url, auth: 'headers', headers: { Authorization: 'Bearer fixture-key' } })
    const result = await harness.apps.list(granted)
    expect(result.tools).toEqual([])
    expect(JSON.stringify(result)).not.toContain('fixture-key')
    expect(harness.apps.connections.find(saved.id).error).toContain('address and sign-in')
  })

  it('asks for sign-in instead of contacting an OAuth server without saved tokens, and never opens a browser from a run', async () => {
    const server = await remoteFixture()
    const { harness, granted } = await live()
    const opened: unknown[] = []
    harness.bus.on((notice) => void (notice.type === 'connections.openUrl' && opened.push(notice)))
    const saved = await harness.apps.save({ ...remote, url: server.url, auth: 'oauth' })
    expect(saved.authState).toBe('signed_out')
    const result = await harness.apps.list(granted)
    expect(result.errors[0].message).toContain('sign in again')
    expect(server.requests).toEqual([])
    expect(opened).toEqual([])
    expect(harness.apps.connections.find(saved.id).authState).toBe('expired')
  })

  it('rejects what a connection must not be', async () => {
    const { harness } = await live()
    await expect(harness.apps.save({ ...remote, url: 'http://mcp.example.com/mcp', auth: 'none' })).rejects.toThrow('https://')
    await expect(harness.apps.save({ name: '', kind: 'local', command: 'x' })).rejects.toThrow('A name, executable')
    await expect(harness.apps.save({ ...local, env: { 'BAD NAME': 'x' } })).rejects.toThrow('environment variable')
    await expect(harness.apps.save({ ...remote, url: 'https://x.example/mcp', auth: 'headers', headers: { 'X-Key': 'a\nb' } })).rejects.toThrow('header')
    const workspace = await harness.apps.save({ name: 'Xingular Workspace', kind: 'workspace', command: process.execPath, enabled: true, global: true })
    expect(() => harness.apps.connections.allowTool(workspace.id, 'x_workspace_mutation_apply')).toThrow('one at a time')
    await harness.apps.remove(workspace.id)
    expect(harness.apps.connections.list()).toEqual([])
  })
})

/** A protected MCP server together with its authorization server, as hosted providers run them. */
async function oauthFixture() {
  const seen = { registered: 0, tokenRequests: [] as string[], authorizeUrls: [] as URL[] }
  const server = createServer(async (request, response) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const url = new URL(request.url ?? '/', base)
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    const json = (status: number, value: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] })
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'] })
    if (url.pathname === '/register') {
      seen.registered += 1
      return json(201, { ...JSON.parse(body.toString()), client_id: 'registered-client' })
    }
    if (url.pathname === '/authorize') {
      seen.authorizeUrls.push(url)
      return response.writeHead(302, { location: `${url.searchParams.get('redirect_uri')}?code=fixture-code&state=${url.searchParams.get('state')}` }).end()
    }
    if (url.pathname === '/token') {
      seen.tokenRequests.push(`${request.headers.authorization ?? ''} ${body.toString()}`)
      return json(200, { access_token: 'fixture-access', token_type: 'Bearer', expires_in: 3600, refresh_token: 'fixture-refresh' })
    }
    if (url.pathname !== '/mcp' || request.method !== 'POST') return response.writeHead(404).end()
    if (request.headers.authorization !== 'Bearer fixture-access') return response.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` }).end()
    const mcp = new McpServer({ name: 'oauth-fixture', version: '1' })
    mcp.registerTool('read_record', { description: 'Read protected record' }, async () => ({ content: [{ type: 'text', text: 'protected record' }] }))
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await mcp.connect(transport)
    const reply = await transport.handleRequest(new Request(`${base}/mcp`, { method: 'POST', headers: request.headers as Record<string, string>, body }))
    response.writeHead(reply.status, Object.fromEntries(reply.headers)).end(Buffer.from(await reply.arrayBuffer()))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(() => {
    server.close()
    server.closeAllConnections()
  })
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen }
}

describe('signing in to a remote connected app', () => {
  it('signs in through the browser with dynamic registration, then a session uses the saved tokens', async () => {
    const server = await oauthFixture()
    const { harness, granted, secrets } = await live()
    let opened = 0
    // Stands in for the application: a browser that approves at once.
    harness.bus.on((notice) => {
      if (notice.type !== 'connections.openUrl') return
      opened += 1
      void fetch(String(notice.url))
    })
    const saved = await harness.apps.save({ name: 'OAuth', kind: 'remote', enabled: true, global: true, url: server.url, auth: 'oauth', oauthScopes: ['read'], readTools: ['read_record'] })
    expect((await harness.apps.signIn(saved.id)).authState).toBe('signed_in')
    expect(JSON.parse(secrets.values.get(`mcp--${saved.id}/oauth`)!).tokens).toMatchObject({ access_token: 'fixture-access', refresh_token: 'fixture-refresh' })
    expect(server.seen.registered).toBe(1)
    expect(server.seen.authorizeUrls[0].searchParams.get('scope')).toBe('read')
    expect(server.seen.authorizeUrls[0].searchParams.get('code_challenge_method')).toBe('S256')
    const listed = await harness.apps.list(granted)
    expect(listed.errors).toEqual([])
    const read = listed.tools.find((tool) => tool.tool === 'read_record')!
    await harness.apps.invoke(granted, read.name, {})
    expect(opened).toBe(1)
    // The tokens a result might quote are removed from what is stored.
    expect(harness.apps.connections.scrub({ content: [{ text: 'fixture-access fixture-refresh kept' }] }, saved.id)).toEqual({ content: [{ text: '[redacted] [redacted] kept' }] })
    expect((await harness.apps.signOut(saved.id)).authState).toBe('signed_out')
    expect(secrets.values.has(`mcp--${saved.id}/oauth`)).toBe(false)
  })

  it('uses a client the user registered, and ignores a callback that does not carry this sign-in\'s state', async () => {
    const server = await oauthFixture()
    const { harness } = await live()
    let forged = 0
    harness.bus.on((notice) => {
      if (notice.type !== 'connections.openUrl') return
      void (async () => {
        forged = (await fetch('http://127.0.0.1:47823/oauth/callback?code=stolen&state=wrong')).status
        await fetch(String(notice.url))
      })()
    })
    const saved = await harness.apps.save({ name: 'Own client', kind: 'remote', enabled: true, global: true, url: server.url, auth: 'oauth', oauthClient: 'user', oauthCredentials: { clientId: 'own-client', clientSecret: 'own-secret' } })
    await harness.apps.signIn(saved.id)
    expect(forged).toBe(400)
    expect(server.seen.registered).toBe(0)
    expect(server.seen.authorizeUrls[0].searchParams.get('client_id')).toBe('own-client')
    expect(server.seen.tokenRequests).toHaveLength(1)
    expect(server.seen.tokenRequests[0]).toContain('fixture-code')
    expect(server.seen.tokenRequests[0]).toMatch(/own-client|b3duLWNsaWVudDpvd24tc2VjcmV0/)
  })
})
