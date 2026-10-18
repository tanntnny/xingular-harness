import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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
import { LOG_READ_CHUNK_BYTES } from './logs'

const open: Harness[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const harness of open.splice(0)) await harness.close()
})

function tellOn(connection: SocketConnection, event: string, data: Record<string, unknown> = {}) {
  return new Promise<any>((resolve, reject) => {
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
}

async function setup(policy: ToolPolicy = {}) {
  const root = rootWithProject()
  const harness = createHarness({ dataRoot: root, stateDir: mkdtempSync(join(tmpdir(), 'hs-')), secrets: memorySecretStore(), policy, piProgram: () => '/opt/pi/bin/pi', assets: { node: '/opt/node', cli: '/opt/harness/cli.js', piExtension: '/opt/harness/terminal-pi.js' } })
  const legacyBin = join(harness.stateDir, 'run', 'bin')
  mkdirSync(legacyBin, { recursive: true })
  writeFileSync(join(legacyBin, 'agentx-wiki'), 'old wrapper')
  writeFileSync(join(legacyBin, 'agentx-mcp'), 'old wrapper')
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
  const tell = (event: string, data: Record<string, unknown> = {}) => tellOn(connection, event, data)
  return { harness, root, account, events, notices, launch, connection, tell, sessionFolder }
}

describe('a pi terminal session', () => {
  it('launches on the pinned account with compiled instructions, the extension, and the session socket', async () => {
    const { launch, account, harness, sessionFolder, root } = await setup()
    expect(launch.program).toBe('/opt/pi/bin/pi')
    expect(launch.accountId).toBe(account.id)
    expect(launch.args[0]).toBe('--append-system-prompt')
    expect(launch.args[1]).toContain('# Xingular Harness context')
    expect(launch.args[1]).toContain('xagent-wiki')
    // Pi's own discovery is off; its command's built-in extensions are named, and the harness's comes last.
    expect(launch.args.slice(2)).toEqual([
      '--model', 'chosen-model', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
      '--extension', 'builtin:llama.cpp', '--extension', 'builtin:codemode', '--extension', 'builtin:tool-search', '--extension', 'builtin:mcp',
      '--extension', '/opt/harness/terminal-pi.js', '--session-dir', join(sessionFolder, 'pi')
    ])
    expect(launch.env.PI_CODING_AGENT_DIR).toBe(join(harness.accounts.dir, account.id, 'home', 'pi'))
    expect(String(launch.env.PATH).split(':')[0]).toBe(join(harness.stateDir, 'run', 'bin'))
    expect(readFileSync(join(harness.stateDir, 'run', 'bin', 'xagent-wiki'), 'utf8')).toBe("#!/bin/sh\nexec '/opt/node' '/opt/harness/cli.js' wiki \"$@\"\n")
    expect(readFileSync(join(harness.stateDir, 'run', 'bin', 'xagent-mcp'), 'utf8')).toContain("'/opt/harness/cli.js' mcp")
    expect(existsSync(join(harness.stateDir, 'run', 'bin', 'agentx-wiki'))).toBe(false)
    expect(existsSync(join(harness.stateDir, 'run', 'bin', 'agentx-mcp'))).toBe(false)
    // The session keeps the pack it started with.
    expect(JSON.parse(readFileSync(join(sessionFolder, 'context.json'), 'utf8')).profile).toBe('session')
    expect(root).toBeTruthy()
  })

  it.skipIf(process.platform !== 'win32')('starts the resolved Pi CLI through Node without a model or interactive terminal', async () => {
    const root = rootWithProject()
    const stateDir = mkdtempSync(join(tmpdir(), 'hs-pi-smoke-'))
    const harness = createHarness({ dataRoot: root, stateDir, secrets: memorySecretStore() })
    open.push(harness)
    harness.accounts.create('Main', 'subscription')
    const launch = await harness.terminals.prepare({ sessionId: 'pi-smoke', cwd: root, sessionFolder: join(root, 'sessions', 'pi-smoke') })
    const cli = launch.args[0]
    const pathKeys = Object.keys(launch.env).filter((name) => name.toLowerCase() === 'path')

    expect(launch.program).toBe(process.execPath)
    expect(pathKeys).toHaveLength(1)
    expect(launch.env[pathKeys[0]]).toContain(';')
    expect(launch.env.XINGULAR_HARNESS_NODE).toBe(process.execPath)
    expect(readFileSync(join(stateDir, 'run', 'bin', 'xagent-wiki.cmd'), 'utf8')).toContain(' wiki %*\r\n')
    const result = spawnSync(launch.program, [cli, '--help'], { cwd: root, encoding: 'utf8', timeout: 20_000 })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/usage|options|pi coding agent/i)
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

  it('protects permission controls and shares saved terminal grants across sessions', async () => {
    const { connection, harness, account, root } = await setup()
    await expect(socketCall(connection, 'terminal.permissions.get')).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(socketCall(connection, 'terminal.policy', { tool: 'bash', args: {} })).rejects.toMatchObject({ code: 'unauthorized' })
    const { key } = await socketCall<{ key: string }>(connection, 'control.claim')
    expect(await socketCall(connection, 'terminal.permissions.get', {}, 1000, key)).toEqual({ full: false, globalTools: [] })
    await socketCall(connection, 'terminal.permissions.setTool', { tool: 'bash', allowed: true }, 1000, key)
    await socketCall(connection, 'terminal.permissions.setFull', { enabled: true }, 1000, key)

    const secondLaunch = await harness.terminals.prepare({ sessionId: 'term-2', accountId: account.id, projectId: 'p1', cwd: root, sessionFolder: join(root, 'sessions', 'p1', 'term-2') })
    const secondConnection: SocketConnection = { socket: String(secondLaunch.env[SOCKET_ENV]), token: String(secondLaunch.env[TOKEN_ENV]) }
    const { key: secondKey } = await socketCall<{ key: string }>(secondConnection, 'control.claim')
    expect(await socketCall(secondConnection, 'terminal.permissions.get', {}, 1000, secondKey)).toEqual({ full: true, globalTools: ['bash'] })
    await socketCall(secondConnection, 'terminal.permissions.setTool', { tool: 'bash', allowed: false }, 1000, secondKey)
    expect(await socketCall(connection, 'terminal.permissions.get', {}, 1000, key)).toEqual({ full: true, globalTools: [] })
    await expect(socketCall(connection, 'terminal.permissions.setFull', { enabled: 'yes' }, 1000, key)).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('does not let a permission change retroactively resolve an already pending approval', async () => {
    const { connection, tell } = await setup()
    await tell('ready')
    await tell('begin', { text: 'Wait for a decision' })
    const { key } = await socketCall<{ key: string }>(connection, 'control.claim')
    const approval = socketCall<{ decision: string }>(connection, 'terminal.approval', { requestId: 'already-pending', tool: 'bash', args: { command: 'pwd' } }, 1000, key)
    let requestId = ''
    await vi.waitFor(async () => {
      const { requests } = await socketCall<{ requests: Array<{ requestId: string }> }>(connection, 'terminal.pending', {}, 1000, key)
      expect(requests).toHaveLength(1)
      requestId = requests[0]!.requestId
    })

    await socketCall(connection, 'terminal.permissions.setFull', { enabled: true }, 1000, key)
    expect(await socketCall(connection, 'terminal.pending', {}, 1000, key)).toMatchObject({ requests: [{ requestId }] })
    await socketCall(connection, 'terminal.approve', { requestId, decision: 'denied' }, 1000, key)
    expect(await approval).toEqual({ decision: 'denied' })
  })

  it('rechecks native tool policy when a pending approval is resolved', async () => {
    let denied = false
    const { connection, tell } = await setup({
      scope: async () => denied ? { allowed: false, reason: 'The policy now denies this tool.' } : { allowed: true, requiresApproval: true }
    })
    await tell('ready')
    await tell('begin', { text: 'Run a tool' })
    const { key } = await socketCall<{ key: string }>(connection, 'control.claim')
    expect(await socketCall(connection, 'terminal.policy', { tool: 'bash', args: { command: 'pwd' } }, 1000, key)).toMatchObject({ requiresApproval: true, rememberable: true })
    const approval = socketCall<{ decision: string }>(connection, 'terminal.approval', { requestId: 'call-approval', tool: 'bash', args: { command: 'pwd' } }, 1000, key)
    let requestId = ''
    await vi.waitFor(async () => {
      const pending = await socketCall<{ requests: Array<{ requestId: string }> }>(connection, 'terminal.pending', {}, 1000, key)
      expect(pending.requests).toHaveLength(1)
      requestId = pending.requests[0]!.requestId
    })

    denied = true
    await socketCall(connection, 'terminal.approve', { requestId, decision: 'approved' }, 1000, key)
    expect(await approval).toEqual({ decision: 'denied' })
  })

  it('keeps human-only rules out of tool grants and Full Permission unless the host opts in', async () => {
    const { connection, tell, events, harness } = await setup({
      scope: async () => ({ allowed: true, humanOnly: true, allowGlobalApproval: false })
    })
    harness.approvals.setAuto('pi', true)
    await tell('ready')
    await tell('begin', { text: 'Human decision required' })
    const { key } = await socketCall<{ key: string }>(connection, 'control.claim')
    expect(await socketCall(connection, 'terminal.policy', { tool: 'bash', args: {} }, 1000, key)).toMatchObject({ requiresApproval: true, rememberable: false, standing: 'none' })
    const approval = socketCall<{ decision: string }>(connection, 'terminal.approval', { requestId: 'human-only', tool: 'bash', args: {} }, 1000, key)
    let requestId = ''
    await vi.waitFor(async () => {
      expect(events.some(event => event.type === 'approval.requested')).toBe(true)
      const { requests } = await socketCall<{ requests: Array<{ requestId: string; rememberable?: boolean }> }>(connection, 'terminal.pending', {}, 1000, key)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.rememberable).toBe(false)
      requestId = requests[0]!.requestId
    })
    await socketCall(connection, 'terminal.approve', { requestId, decision: 'denied' }, 1000, key)
    expect(await approval).toEqual({ decision: 'denied' })
  })

  it('remembers a tool choice for future Pi terminal sessions sharing the state directory', async () => {
    const { connection, tell, events, harness, account, root } = await setup()
    await tell('ready')
    await tell('begin', { text: 'Allow a tool' })
    const { key } = await socketCall<{ key: string }>(connection, 'control.claim')
    const first = socketCall<{ decision: string }>(connection, 'terminal.approval', { requestId: 'remember-call', tool: 'bash', args: { command: 'pwd' } }, 1000, key)
    let requestId = ''
    await vi.waitFor(async () => {
      const { requests } = await socketCall<{ requests: Array<{ requestId: string; rememberable?: boolean }> }>(connection, 'terminal.pending', {}, 1000, key)
      expect(requests[0]?.rememberable).toBe(true)
      requestId = requests[0]!.requestId
    })
    await socketCall(connection, 'terminal.approve', { requestId, decision: 'approved', alwaysAllow: true }, 1000, key)
    expect(await first).toEqual({ decision: 'approved' })
    expect(harness.approvals.read().globalTools.pi).toEqual(['bash'])

    const launch = await harness.terminals.prepare({ sessionId: 'term-2', accountId: account.id, projectId: 'p1', cwd: root, sessionFolder: join(root, 'sessions', 'p1', 'term-2') })
    const next: SocketConnection = { socket: String(launch.env[SOCKET_ENV]), token: String(launch.env[TOKEN_ENV]) }
    await tellOn(next, 'startup', { phase: 'ready' })
    await tellOn(next, 'ready')
    await tellOn(next, 'begin', { text: 'Reuse the grant' })
    const { key: nextKey } = await socketCall<{ key: string }>(next, 'control.claim')
    const before = events.filter(event => event.type === 'approval.requested').length
    expect(await socketCall(next, 'terminal.approval', { requestId: 'next-call', tool: 'bash', args: { command: 'git status' } }, 1000, nextKey)).toEqual({ decision: 'approved' })
    const automatic = events.filter(event => event.type === 'approval.requested').slice(before)
    expect(automatic).toHaveLength(1)
    expect(automatic[0]?.payload).toMatchObject({ automatic: 'remembered', target: 'bash' })
    expect(await socketCall(next, 'terminal.pending', {}, 1000, nextKey)).toEqual({ requests: [] })
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
    // Account calls exist, but only the session's extension holds the key that unlocks them.
    await expect(socketCall(connection, 'accounts.list')).rejects.toMatchObject({ code: 'unauthorized' })
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

describe('xagent-wiki command', () => {
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


describe('decisions in the Harness-owned frontend', () => {
  it('exposes trajectory reads only to the input owner and scopes them to the current native conversation', async () => {
    const { connection, tell, events } = await setup()
    await tell('ready', { nativeSessionId: '/history/current.jsonl' })
    await tell('begin', { text: 'Inspect this run' })
    await tell('message', { text: 'Recorded response' })
    await tell('settled', {})
    const runId = events.find(event => event.type === 'started')!.runId

    await expect(socketCall(connection, 'terminal.trajectory.list')).rejects.toMatchObject({ code: 'unauthorized' })
    const { key } = await socketCall<{ key: string }>(connection, 'control.claim')
    const listed = await socketCall<{ runs: Array<{ id: string }> }>(connection, 'terminal.trajectory.list', {}, 1000, key)
    expect(listed.runs.map(run => run.id)).toContain(runId)
    await expect(socketCall(connection, 'terminal.trajectory.events', { runId }, 1000, key)).resolves.toMatchObject({
      run: { id: runId }, events: expect.arrayContaining([expect.objectContaining({ type: 'message.completed' })])
    })

    await tell('ready', { nativeSessionId: '/history/another.jsonl' })
    await expect(socketCall(connection, 'terminal.trajectory.events', { runId }, 1000, key)).rejects.toMatchObject({ code: 'not_found' })
    await expect(socketCall(connection, 'terminal.trajectory.list', {}, 1000, key)).resolves.toEqual({ runs: [] })
  })

  it('serves a bounded diagnostic snapshot only through the private terminal control channel', async () => {
    const { connection, harness } = await setup()
    await expect(socketCall(connection, 'terminal.logs.info')).rejects.toMatchObject({ code: 'unauthorized' })
    const { key } = await socketCall<{ key: string }>(connection, 'control.claim')
    await expect(socketCall(connection, 'terminal.logs.info', {}, 1000, key)).resolves.toEqual({ size: null })
    await expect(socketCall(connection, 'terminal.logs.read', { snapshotSize: 1, offset: 0 }, 1000, key)).rejects.toMatchObject({ code: 'invalid_request' })

    const text = `${'a'.repeat(LOG_READ_CHUNK_BYTES - 1)}🧠tail`
    writeFileSync(join(harness.stateDir, 'harness.log'), text)
    const { size } = await socketCall<{ size: number }>(connection, 'terminal.logs.info', {}, 1000, key)
    expect(size).toBe(Buffer.byteLength(text))
    await expect(socketCall(connection, 'terminal.logs.read', { snapshotSize: size, offset: size }, 1000, key)).rejects.toMatchObject({ code: 'invalid_request' })
    const first = await socketCall<{ data: string; nextOffset: number }>(connection, 'terminal.logs.read', { snapshotSize: size, offset: 0 }, 1000, key)
    const second = await socketCall<{ data: string; nextOffset: number }>(connection, 'terminal.logs.read', { snapshotSize: size, offset: first.nextOffset }, 1000, key)
    expect(first.nextOffset).toBe(LOG_READ_CHUNK_BYTES)
    expect(second.nextOffset).toBe(size)
    expect(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(second.data, 'base64')]).toString('utf8')).toBe(text)
  })

  it('requires the private input-owner key for pending decisions and exact draft state', async () => {
    const { connection, harness, tell } = await setup()
    await tell('ready', { nativeSessionId: '/native.jsonl' })
    await expect(socketCall(connection, 'terminal.pending')).rejects.toMatchObject({ code: 'unauthorized' })
    const { key } = await socketCall<{ key: string }>(connection, 'control.claim')
    await socketCall(connection, 'terminal.draft', { dirty: true }, 1000, key)
    expect(harness.terminals.state('term-1').dirty).toBe(true)
    await socketCall(connection, 'terminal.draft', { dirty: false }, 1000, key)
    expect(harness.terminals.state('term-1').dirty).toBe(false)
    await expect(socketCall(connection, 'terminal.approve', { requestId: 'missing', decision: 'approved' }, 1000, key)).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('answers through the existing run registry and rejects stale answers', async () => {
    const { connection, tell, events } = await setup()
    const { key } = await socketCall<{ key: string }>(connection, 'control.claim')
    await tell('ready')
    await tell('begin', { text: 'Ask a question' })
    const answer = tell('question', { requestId: 'native-question', question: 'Choose?', options: [{ label: 'A', description: 'First' }], multiSelect: false })
    let id = ''
    await vi.waitFor(async () => {
      const pending = await socketCall<{ requests: Array<{ requestId: string }> }>(connection, 'terminal.pending', {}, 1000, key)
      expect(pending.requests).toHaveLength(1)
      id = pending.requests[0].requestId
    })
    await socketCall(connection, 'terminal.answer', { requestId: id, answer: { selected: ['A'] } }, 1000, key)
    expect(await answer).toEqual({ selected: ['A'] })
    expect(events.some(event => event.type === 'question.answered')).toBe(true)
    await expect(socketCall(connection, 'terminal.answer', { requestId: id, answer: { selected: ['A'] } }, 1000, key)).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('keeps an approval and question with the same native tool id independent', async () => {
    const { connection, tell } = await setup()
    const { key } = await socketCall<{ key: string }>(connection, 'control.claim')
    await tell('ready'); await tell('begin', { text: 'Ask after approval' })
    const approval = tell('approval', { requestId: 'same-tool-call', target: 'ask_user_question', action: '{}' })
    let approvalId = ''
    await vi.waitFor(async () => {
      const { requests } = await socketCall<{ requests: Array<{ requestId: string }> }>(connection, 'terminal.pending', {}, 1000, key)
      expect(requests).toHaveLength(1); approvalId = requests[0].requestId
    })
    await socketCall(connection, 'terminal.approve', { requestId: approvalId, decision: 'approved' }, 1000, key)
    expect(await approval).toEqual({ decision: 'approved' })
    const question = tell('question', { requestId: 'same-tool-call', question: 'Continue?', options: [{ label: 'Yes' }] })
    let questionId = ''
    await vi.waitFor(async () => {
      const { requests } = await socketCall<{ requests: Array<{ requestId: string; type: string }> }>(connection, 'terminal.pending', {}, 1000, key)
      expect(requests).toHaveLength(1); expect(requests[0].type).toBe('question'); questionId = requests[0].requestId
    })
    expect(questionId).not.toBe(approvalId)
    await socketCall(connection, 'terminal.answer', { requestId: questionId, answer: { selected: ['Yes'] } }, 1000, key)
    expect(await question).toEqual({ selected: ['Yes'] })
  })

  it('cancels a pending question through the run interrupt path', async () => {
    const { connection, tell, harness } = await setup()
    const { key } = await socketCall<{ key: string }>(connection, 'control.claim')
    await tell('ready')
    await tell('begin', { text: 'Wait for a question' })
    const answer = tell('question', { requestId: 'cancel-question', question: 'Wait?', options: [], multiSelect: false })
    await vi.waitFor(async () => expect((await socketCall<{ requests: unknown[] }>(connection, 'terminal.pending', {}, 1000, key)).requests).toHaveLength(1))
    await socketCall(connection, 'terminal.interrupt', {}, 1000, key)
    expect(await answer).toEqual({ selected: [] })
    expect(harness.terminals.state('term-1').active).toBe(false)
  })
})
