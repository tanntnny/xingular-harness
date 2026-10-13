import { mkdtempSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import type { RunEvent } from '../sessions/contracts'
import type { ToolPolicy } from '../sessions/policy'
import { loadRun } from '../sessions/runStore'
import type { Found } from '../plugins/discover'
import { rootWithProject, writeFile } from '../../tests/helpers'
import { parseCli } from './cli'
import { SOCKET_ENV, TOKEN_ENV, socketCall, type SocketConnection } from './client'
import { SessionSocket } from './socket'

const open: Harness[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const harness of open.splice(0)) await harness.close()
})

async function setup(policy: ToolPolicy = {}) {
  const root = rootWithProject()
  const harness = createHarness({ dataRoot: root, stateDir: mkdtempSync(join(tmpdir(), 'hs-')), secrets: memorySecretStore(), policy, piProgram: () => '/opt/pi/bin/pi', assets: { node: '/opt/node', cli: '/opt/harness/cli.js', piExtension: '/opt/harness/terminal-pi.js' } })
  open.push(harness)
  const account = harness.accounts.create('Main', 'apiKey').accounts[0]
  const events: RunEvent[] = []
  const notices: Record<string, unknown>[] = []
  harness.runs.listen((event) => void events.push(event))
  harness.bus.on((notice) => void notices.push(notice))
  const sessionFolder = join(root, 'sessions', 'p1', 'term-1')
  const launch = await harness.terminals.prepare({ sessionId: 'term-1', accountId: account.id, projectId: 'p1', cwd: root, sessionFolder, model: 'chosen-model', launch: { connections: 'Use mcp_list_tools.' } })
  const connection: SocketConnection = { socket: String(launch.env[SOCKET_ENV]), token: String(launch.env[TOKEN_ENV]) }
  /** One telemetry line, as the native extension sends it. */
  const tell = (event: string, data: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      const stream = connect(connection.socket)
      let buffer = ''
      stream.on('connect', () => stream.write(`${JSON.stringify({ token: connection.token, event, data })}\n`))
      stream.on('data', (chunk) => {
        buffer += chunk.toString()
        if (!buffer.includes('\n')) return
        const reply = JSON.parse(buffer.slice(0, buffer.indexOf('\n')))
        stream.end()
        if (reply.error) reject(new Error(reply.error.message))
        else resolve(reply.result)
      })
      stream.on('error', reject)
    })
  return { harness, root, account, events, notices, launch, connection, tell, sessionFolder }
}

describe('a pi terminal session', () => {
  it('launches on the pinned account with compiled instructions, the extension, and the session socket', async () => {
    const { launch, account, harness, sessionFolder, root } = await setup()
    expect(launch.program).toBe('/opt/pi/bin/pi')
    expect(launch.accountId).toBe(account.id)
    expect(launch.args[0]).toBe('--append-system-prompt')
    expect(launch.args[1]).toContain('# Xingular Harness context')
    expect(launch.args[1]).toContain('agentx-wiki')
    // Pi's own discovery is off; its command's built-in extensions are named, and the harness's comes last.
    expect(launch.args.slice(2)).toEqual([
      '--model', 'chosen-model', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
      '--extension', 'builtin:llama.cpp', '--extension', 'builtin:codemode', '--extension', 'builtin:tool-search', '--extension', 'builtin:mcp',
      '--extension', '/opt/harness/terminal-pi.js', '--session-dir', join(sessionFolder, 'pi')
    ])
    expect(launch.env.PI_CODING_AGENT_DIR).toBe(join(harness.accounts.dir, account.id, 'home', 'pi'))
    expect(String(launch.env.PATH).split(':')[0]).toBe(join(harness.stateDir, 'run', 'bin'))
    expect(readFileSync(join(harness.stateDir, 'run', 'bin', 'agentx-wiki'), 'utf8')).toBe("#!/bin/sh\nexec '/opt/node' '/opt/harness/cli.js' wiki \"$@\"\n")
    expect(readFileSync(join(harness.stateDir, 'run', 'bin', 'agentx-mcp'), 'utf8')).toContain("'/opt/harness/cli.js' mcp")
    // The session keeps the pack it started with.
    expect(JSON.parse(readFileSync(join(sessionFolder, 'context.json'), 'utf8')).profile).toBe('session')
    expect(root).toBeTruthy()
  })

  it('passes what the harness found as paths, the enabled registry items with them, and its own extension last', async () => {
    const root = rootWithProject()
    writeFile(join(root, 'registry/skills/release/SKILL.md'), '# Release\n')
    writeFile(join(root, 'registry/prompts/review.md'), 'Review this.\n')
    writeFile(join(root, 'config/registry-enabled.json'), JSON.stringify({ p1: ['skills/release', 'prompts/review'] }))
    writeFile(join(root, '.pi/extensions/local.ts'), 'export default function () {}\n')
    const item = (kind: Found['kind'], path: string, origin: Found['origin'], enabled = true): Found => ({ kind, path, origin, project: origin === 'project', packageRoot: null, source: null, enabled })
    const found = [
      item('extension', join(root, '.pi/extensions/local.ts'), 'project'),
      item('extension', '/shared/extensions/mine.ts', 'shared'),
      item('extension', '/shared/extensions/off.ts', 'shared', false),
      item('extension', 'builtin:mcp', 'builtin'),
      item('skill', '/shared/skills/alpha/SKILL.md', 'shared'),
      item('prompt', '/shared/prompts/p.md', 'shared'),
      item('theme', '/shared/themes/dark.json', 'shared')
    ]
    const harness = createHarness({ dataRoot: root, stateDir: mkdtempSync(join(tmpdir(), 'hs-')), secrets: memorySecretStore(), piProgram: () => '/opt/pi/bin/pi', assets: { node: '/opt/node', cli: '/opt/harness/cli.js', piExtension: '/opt/harness/terminal-pi.js' }, resolver: async () => found })
    open.push(harness)
    const account = harness.accounts.create('Main', 'apiKey').accounts[0]
    const prepare = async () => (await harness.terminals.prepare({ sessionId: 'term-1', accountId: account.id, projectId: 'p1', cwd: root, sessionFolder: join(root, 'sessions', 'p1', 'term-1') })).args.slice(2)

    const loaded = [
      '--extension', '/shared/extensions/mine.ts', '--extension', 'builtin:mcp',
      '--skill', join(root, 'registry/skills/release/SKILL.md'), '--skill', '/shared/skills/alpha/SKILL.md',
      '--prompt-template', join(root, 'registry/prompts/review.md'), '--prompt-template', '/shared/prompts/p.md',
      '--theme', '/shared/themes/dark.json',
      '--extension', '/opt/harness/terminal-pi.js', '--session-dir', join(root, 'sessions', 'p1', 'term-1', 'pi')
    ]
    const flags = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes']
    expect(await prepare()).toEqual([...flags, ...loaded])

    // The working folder's own code joins only once a person trusted it.
    const code = (await harness.plugins.loading({ cwd: root, agentDir: join(harness.accounts.dir, account.id, 'home', 'pi') })).projectCode!
    harness.plugins.trust.grant(code, root)
    expect(await prepare()).toEqual([...flags, '--extension', join(root, '.pi/extensions/local.ts'), ...loaded])
  })

  it('refuses to launch without the pi command, and never on another account', async () => {
    const harness = createHarness({ dataRoot: rootWithProject(), stateDir: mkdtempSync(join(tmpdir(), 'hs-')), secrets: memorySecretStore(), piProgram: () => null })
    open.push(harness)
    harness.accounts.create('Main', 'apiKey')
    await expect(harness.terminals.prepare({ sessionId: 's', cwd: '/tmp', sessionFolder: join(harness.env.root, 'sessions', 's') })).rejects.toMatchObject({ code: 'harness_unavailable' })
    const other = createHarness({ dataRoot: rootWithProject(), stateDir: mkdtempSync(join(tmpdir(), 'hs-')), secrets: memorySecretStore(), piProgram: () => '/opt/pi' })
    open.push(other)
    other.accounts.create('Main', 'apiKey')
    await expect(other.terminals.prepare({ sessionId: 's', accountId: 'missing-account', cwd: '/tmp', sessionFolder: join(other.env.root, 'sessions', 's') })).rejects.toThrow()
    expect(other.terminals.has('s')).toBe(false)
  })

  it('records what the person typed as a run and follows it to the end', async () => {
    const { tell, events, harness, root, notices } = await setup()
    await tell('startup', { phase: 'Pi extension loaded' })
    await tell('ready', { nativeSessionId: '/history/native.jsonl' })
    expect(notices).toContainEqual({ type: 'terminal.native', sessionId: 'term-1', nativeSessionId: '/history/native.jsonl' })
    await tell('begin', { text: 'Fix the build' })
    const runId = events[0].runId
    expect(loadRun(root, runId)).toMatchObject({ mode: 'code', harness: 'pi', sessionType: 'terminal', sessionId: 'term-1', projectId: 'p1', goal: 'Fix the build', nativeSessionId: '/history/native.jsonl' })
    await tell('tool', { phase: 'start', id: 't1', name: 'read', summary: '{"path":"a"}' })
    await tell('tool', { phase: 'end', id: 't1', name: 'read', ok: true, durationMs: 4, resultChars: 12 })
    await tell('message', { text: 'Done.' })
    await tell('usage', { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 })
    await tell('settled', {})
    expect(events.map((event) => event.type)).toEqual(['started', 'status.changed', 'message.completed', 'tool.started', 'tool.completed', 'message.completed', 'usage.updated', 'completed'])
    expect(loadRun(root, runId).status).toBe('completed')
    expect(harness.terminals.state('term-1')).toEqual({ ready: true, dirty: false, active: false })
    // The run has the pack its session started with.
    expect(JSON.parse(readFileSync(join(root, 'runs', runId, 'context.json'), 'utf8')).runId).toBe(runId)
  })

  it('delivers an instruction through the extension and reserves its run first', async () => {
    const { tell, harness, root, events } = await setup()
    await tell('ready', {})
    const sent = harness.terminals.send({ sessionId: 'term-1', runId: 'reserved', text: 'Run the tests' })
    await vi.waitFor(async () => expect(await tell('poll')).toEqual({ command: { type: 'send', text: 'Run the tests' } }))
    expect(loadRun(root, 'reserved')).toMatchObject({ status: 'queued', goal: 'Run the tests' })
    await tell('begin', { text: 'Run the tests' })
    expect(await sent).toEqual({ runId: 'reserved' })
    expect(events[0]).toMatchObject({ runId: 'reserved', type: 'started' })
    await expect(harness.terminals.send({ sessionId: 'term-1', text: 'Another' })).rejects.toMatchObject({ code: 'session_busy' })
    await harness.runs.interrupt('reserved')
    expect(await tell('poll')).toEqual({ command: { type: 'interrupt' } })
    expect(loadRun(root, 'reserved').status).toBe('interrupted')
  })

  it('sends a memory block that changed since the session started along with the next instruction', async () => {
    const { tell, harness, connection } = await setup()
    await tell('ready', {})
    await socketCall(connection, 'memory.append', { block: 'project', text: 'Prefers pnpm.' })
    const first = harness.terminals.send({ sessionId: 'term-1', text: 'Continue' })
    let delivered = ''
    await vi.waitFor(async () => {
      const { command } = await tell('poll')
      expect(command?.type).toBe('send')
      delivered = command.text
    })
    await tell('begin', { text: delivered })
    await first
    expect(delivered.startsWith('[Memory updated since this session')).toBe(true)
    expect(delivered).toContain('Prefers pnpm.')
    expect(delivered.endsWith('\n\nContinue')).toBe(true)
  })

  it('will not send over a draft the person is typing, and fails a delivery the native session never acknowledges', async () => {
    const { tell, harness, root } = await setup()
    await tell('ready', {})
    harness.terminals.input('term-1', 'half a thought')
    await expect(harness.terminals.send({ sessionId: 'term-1', runId: 'draft', text: 'Task' })).rejects.toMatchObject({ code: 'terminal_has_draft' })
    expect(loadRun(root, 'draft').status).toBe('failed')
    harness.terminals.input('term-1', '\u0015')
    vi.useFakeTimers()
    const send = harness.terminals.send({ sessionId: 'term-1', runId: 'lost', text: 'Task' })
    const rejected = expect(send).rejects.toMatchObject({ code: 'delivery_uncertain' })
    await vi.advanceTimersByTimeAsync(25_001)
    await rejected
    vi.useRealTimers()
    expect(loadRun(root, 'lost').status).toBe('failed')
    // A late acknowledgement does not start a run for an instruction reported as lost.
    await expect(tell('begin', { text: 'Task' })).rejects.toThrow('will not be resent')
    expect(await tell('poll')).toEqual({ command: { type: 'interrupt' } })
  })

  it('asks before a native action unless the policy allows it, and reads never ask', async () => {
    const { tell, events, harness } = await setup()
    await tell('ready', {})
    await tell('begin', { text: 'Edit' })
    expect(await tell('policy', { tool: 'read', args: { path: 'a' } })).toEqual({ allowed: true })
    expect(await tell('policy', { tool: 'bash', args: { command: 'rm -rf x' } })).toMatchObject({ allowed: false, requiresApproval: true })
    const decision = tell('approval', { requestId: 'call-1', target: 'bash', action: '{"command":"rm -rf x"}', tool: 'bash', args: { command: 'rm -rf x' } })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'approval.requested')).toBe(true))
    const request = events.find((event) => event.type === 'approval.requested')!
    harness.runs.resolveApproval(request.runId, (request.payload as { approvalId: string }).approvalId, 'approved')
    expect(await decision).toEqual({ decision: 'approved' })
  })

  it('applies the application policy to native tool calls', async () => {
    const seen: string[] = []
    const { tell } = await setup({
      scope: async (call) => {
        seen.push(`${call.run.sessionId}:${call.tool}`)
        return call.tool === 'bash' ? { allowed: false, reason: 'Outside the task.' } : { allowed: true }
      },
      authorize: async (call) => {
        if (call.tool === 'write') throw new Error('Switched off.')
      }
    })
    await tell('ready', {})
    await tell('begin', { text: 'Go' })
    expect(await tell('policy', { tool: 'bash', args: {} })).toEqual({ allowed: false, reason: 'Outside the task.' })
    expect(await tell('policy', { tool: 'write', args: {} })).toEqual({ allowed: false, reason: 'Switched off.' })
    expect(await tell('policy', { tool: 'edit', args: {} })).toMatchObject({ allowed: true })
    expect(seen).toEqual(['term-1:bash', 'term-1:write', 'term-1:edit'])
  })

  it('fails the turn and releases its decisions when the native process hangs up mid-question', async () => {
    const { tell, events, harness, connection } = await setup()
    await tell('ready', {})
    await tell('begin', { text: 'task' })
    const socket = connect(connection.socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    socket.write(`${JSON.stringify({ token: connection.token, event: 'question', data: { requestId: 'native-one', question: 'Continue?' } })}\n`)
    await vi.waitFor(() => expect(events.some((event) => event.type === 'question.requested')).toBe(true))
    socket.destroy()
    await vi.waitFor(() => expect(events.some((event) => event.type === 'failed')).toBe(true))
    expect((events.find((event) => event.type === 'failed')!.payload as { message: string }).message).toContain('callback disconnected')
    expect(harness.runs.activeRunIds()).toEqual([])
    expect(harness.terminals.state('term-1').ready).toBe(false)
  })

  it('serves memory and connected apps to the session over the socket, until the terminal ends', async () => {
    const { connection, harness, tell } = await setup()
    await tell('ready', {})
    expect(await socketCall<string>(connection, 'wiki.entrypoint')).toContain('# Xingular Harness context')
    expect(await socketCall<string>(connection, 'wiki.list')).toContain('library')
    const listed = await socketCall<{ tools: { name: string; parameters: { type: string } }[] }>(connection, 'tools.list')
    expect(listed.tools.map((tool) => tool.name)).toEqual(['mcp_list_tools', 'mcp_call_tool'])
    expect(listed.tools[0].parameters.type).toBe('object')
    await expect(socketCall(connection, 'accounts.list')).rejects.toMatchObject({ code: 'unknown_method' })
    await expect(socketCall({ ...connection, token: 'guess' }, 'wiki.list')).rejects.toMatchObject({ code: 'unauthorized' })
    await harness.terminals.dispose('term-1')
    await expect(socketCall(connection, 'wiki.list')).rejects.toMatchObject({ code: 'unauthorized' })
    expect(harness.terminals.has('term-1')).toBe(false)
  })

  it('writes the account credentials for the pi command only while a terminal runs', async () => {
    const { harness, account } = await setup()
    const auth = join(harness.accounts.dir, account.id, 'home', 'pi', 'auth.json')
    expect(JSON.parse(readFileSync(auth, 'utf8'))).toEqual({})
    await harness.terminals.dispose('term-1')
    expect(() => readFileSync(auth, 'utf8')).toThrow()
  })
})

describe('the session socket', () => {
  it('answers only calls it knows, for tokens it issued', async () => {
    const socket = new SessionSocket(join(mkdtempSync(join(tmpdir(), 'sock-')), 's.sock'), { memory: (caller, call) => `${caller.runId}:${call}`, apps: async () => 'apps' })
    const token = socket.issue({ sessionId: 's1', caller: () => ({ runId: 'r1' }), broker: null })
    expect(await socket.handle(JSON.stringify({ token, call: 'wiki.search', params: { query: 'x' } }))).toEqual({ result: 'r1:wiki.search' })
    expect(await socket.handle(JSON.stringify({ token, call: 'agents.create' }))).toMatchObject({ error: { code: 'unknown_method' } })
    expect(await socket.handle(JSON.stringify({ token, call: 'mcp.list' }))).toMatchObject({ error: { code: 'mcp_unauthorized' } })
    expect(await socket.handle(JSON.stringify({ token: 'guess', call: 'wiki.search' }))).toMatchObject({ error: { code: 'unauthorized' } })
    expect(await socket.handle('not json')).toMatchObject({ error: { code: 'invalid_request' } })
    socket.revokeSession('s1')
    expect(await socket.handle(JSON.stringify({ token, call: 'wiki.search' }))).toMatchObject({ error: { code: 'unauthorized' } })
  })
})

describe('agentx-wiki command', () => {
  it('maps commands onto memory and Wiki calls', () => {
    expect(parseCli(['search', 'deploy', 'steps', '--kind', 'page'])).toEqual({ kind: 'call', call: 'wiki.search', params: { query: 'deploy steps', kinds: ['page'] } })
    expect(parseCli(['read', '/projects/app/arch'])).toEqual({ kind: 'call', call: 'wiki.read', params: { id: '/projects/app/arch' } })
    expect(parseCli(['list'])).toEqual({ kind: 'call', call: 'wiki.list', params: {} })
    expect(parseCli(['skill', 'review'])).toEqual({ kind: 'call', call: 'wiki.skill', params: { name: 'review' } })
    expect(parseCli(['memory', '--namespace', '/projects/app'])).toEqual({ kind: 'call', call: 'wiki.memory', params: { namespace: '/projects/app' } })
    expect(parseCli(['recall', 'the', 'outage', '--scope', 'all'])).toEqual({ kind: 'call', call: 'recall.search', params: { query: 'the outage', scope: 'all' } })
    expect(parseCli(['propose', '{"kind":"memory","title":"t","body":"b"}'])).toMatchObject({ kind: 'call', call: 'wiki.propose', params: { kind: 'memory' } })
    expect(parseCli(['propose', '-'])).toEqual({ kind: 'stdin-propose' })
    expect(parseCli(['block', 'append', 'project', 'Uses', 'pnpm.'])).toEqual({ kind: 'call', call: 'memory.append', params: { block: 'project', text: 'Uses pnpm.' } })
    expect(parseCli(['block', 'replace', 'project', '--old', 'npm', '--new', 'pnpm'])).toEqual({ kind: 'call', call: 'memory.replace', params: { block: 'project', old: 'npm', new: 'pnpm' } })
    expect(parseCli(['search'])).toEqual({ kind: 'help' })
    expect(parseCli(['nonsense'])).toEqual({ kind: 'help' })
  })
})
