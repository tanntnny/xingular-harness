import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import type { PiSessionLike } from '../sessions/runner'
import { rootWithProject, writeFile } from '../../tests/helpers'
import { remoteDirectory, remotePolicy, remoteSecrets, remoteTools } from './remote'
import { RpcPeer, type Transport } from './rpc'
import { attach, serve } from './serve'

const open: Harness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})

/** A host on the other end of the protocol: sends requests, answers the harness's calls. */
function host(hostCalls: Record<string, (params: any) => unknown> = {}) {
  let toHarness: (line: string) => void = () => undefined
  const events: any[] = []
  const notices: any[] = []
  const waiting = new Map<string, { resolve: (value: any) => void; reject: (error: any) => void }>()
  let next = 0
  const transport: Transport = {
    onLine: (listener) => void (toHarness = listener),
    write: (line) => {
      const message = JSON.parse(line)
      if (message.event) events.push(message.event)
      else if (message.notice) notices.push(message.notice)
      else if (message.call) {
        queueMicrotask(async () => {
          try {
            const handler = hostCalls[message.call]
            if (!handler) throw new Error(`host has no ${message.call}`)
            toHarness(JSON.stringify({ v: 1, id: message.id, result: (await handler(message.params)) ?? null }))
          } catch (error) {
            toHarness(JSON.stringify({ v: 1, id: message.id, error: { code: 'host_error', message: error instanceof Error ? error.message : String(error) } }))
          }
        })
      } else {
        const pending = waiting.get(message.id)
        waiting.delete(message.id)
        if (message.error) pending?.reject(message.error)
        else pending?.resolve(message.result)
      }
    }
  }
  const request = <T = any>(method: string, params: unknown = {}): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = `h${++next}`
      waiting.set(id, { resolve, reject })
      toHarness(JSON.stringify({ v: 1, id, method, params }))
    })
  return { transport, request, events, notices }
}

const idle = (): PiSessionLike => ({ sessionId: 'native-1', subscribe: () => () => undefined, prompt: async () => undefined, sendCustomMessage: async () => undefined, abort: async () => undefined, dispose: () => undefined })

describe('the harness served to a host', () => {
  it('starts native subagents over RPC using the live parent launch', async () => {
    const { transport, request } = host()
    const harness = createHarness({
      dataRoot: rootWithProject(), stateDir: mkdtempSync(join(tmpdir(), 'hs-')), secrets: memorySecretStore(),
      sessionFactory: async ({ params }) => ({ ...idle(), ...(params.runId === 'rpc-parent' ? { prompt: async () => new Promise<void>(() => undefined) } : {}) })
    })
    open.push(harness)
    serve(harness, transport)
    harness.accounts.create('Main', 'apiKey')
    await request('sessions.run', { run: { id: 'rpc-parent', sessionId: 'opaque-session' }, cwd: harness.env.root, sessionDir: join(harness.env.root, 'sessions'), text: 'Parent', caller: { agentId: 'caller' }, tools: { allow: ['read'] }, subagents: {} })
    const child = await request('subagents.spawn', { parentRunId: 'rpc-parent', brief: 'Review', tools: ['read'] })
    expect(await request('subagents.wait', { parentRunId: 'rpc-parent', runIds: [child.runId] })).toMatchObject([{ runId: child.runId, status: 'completed' }])
    const { loadRun } = await import('../sessions/runStore')
    expect(loadRun(harness.env.root, child.runId)).toMatchObject({ parentRunId: 'rpc-parent', relation: 'subagent', agentId: 'caller', status: 'completed' })
    await request('runs.interrupt', { runId: 'rpc-parent' })
  })

  it('answers by method name, reports failures with their code, and forwards events and notices', async () => {
    const { transport, request, events, notices } = host()
    const harness = createHarness({ dataRoot: rootWithProject(), stateDir: mkdtempSync(join(tmpdir(), 'hs-')), secrets: memorySecretStore(), sessionFactory: async () => idle() })
    open.push(harness)
    serve(harness, transport)

    const status = await request('harness.status')
    expect(status).toMatchObject({ dataRoot: harness.env.root, productName: 'Xingular Harness', activeRuns: [] })
    expect(await request<string[]>('harness.methods')).toEqual(expect.arrayContaining(['accounts.list', 'accounts.choices', 'accounts.choose', 'sessions.run', 'sessions.spawnSubagent', 'subagents.spawn', 'subagents.wait', 'subagents.results', 'wiki.list', 'wiki.write', 'terminal.prepare', 'variants.seed', 'variants.save', 'refine.start', 'refine.adopt', 'library.list', 'connections.list', 'harness.shutdown']))

    await expect(request('sessions.spawnSubagent', { parentRunId: 'missing', brief: 'Review' })).rejects.toMatchObject({ code: 'run_not_active' })

    const overview = await request('accounts.create', { label: 'Main', authKind: 'apiKey' })
    expect(overview.accounts).toHaveLength(1)
    expect(notices).toContainEqual(expect.objectContaining({ type: 'accounts.changed' }))
    await expect(request('accounts.rename', { accountId: 'nope', label: 'x' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(request('accounts.rename', {})).rejects.toMatchObject({ code: 'invalid_request', message: 'accountId is required.' })
    const accountId = overview.accounts[0].id
    expect(await request('accounts.choose', { accountId, mode: 'plan', effort: 'low' })).toMatchObject({ plan: { effort: 'low' } })
    expect(await request('accounts.choices', { accountId })).toMatchObject({ plan: { effort: 'low' } })
    await expect(request('accounts.choose', { accountId, mode: 'plan', effort: 'extreme' })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(request('nope.nothing')).rejects.toMatchObject({ code: 'unknown_method' })

    await request('wiki.write', { path: 'projects/app/decisions', text: '# Decisions\n\nShip on Fridays.\n' })
    expect(notices).toContainEqual({ type: 'wiki.changed' })
    expect(await request('harness.call', { context: { agentId: 'a1', agentName: 'Helper', actor: 'Chat', projectId: 'p1' }, call: 'wiki.search', params: { query: 'Fridays' } })).toContain('projects/app/decisions')
    const compiled = await request('context.compile', { context: { agentId: 'a1', agentName: 'Helper', actor: 'Chat', projectId: 'p1' }, render: true })
    expect(compiled.text).toContain('projects/app/decisions — Decisions')

    const started = await request('sessions.run', { run: { id: 'r1', sessionId: 'a1' }, cwd: harness.env.root, sessionDir: join(harness.env.root, 'sessions', 'a1'), text: 'hello', caller: { agentId: 'a1', agentName: 'Helper', actor: 'Chat' }, tools: { allow: ['read'] } })
    expect(started).toEqual({ runId: 'r1', nativeSessionId: 'native-1' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(events.map((event) => event.type)).toEqual(['started', 'status.changed', 'context.snapshot', 'completed'])
    expect((await request('runs.load', { runId: 'r1' })).run).toMatchObject({ id: 'r1', status: 'completed' })
    expect((await request<any[]>('runs.list', { filter: { sessionId: 'a1' } })).map((run) => run.id)).toEqual(['r1'])
    expect(await request('runs.checklist', { runId: 'r1' })).toEqual([])
    expect(await request('runs.continuation', { runId: 'r1' })).toMatchObject({ runId: 'r1', resumable: false, reason: 'completed' })
    expect((await request('context.runPack', { runId: 'r1' })).sections.map((section: { id: string }) => section.id)).toContain('tools')
  })

  it('lets a host that is not a Node program supply secrets, policy, names, and tools over the protocol', async () => {
    const secrets = new Map<string, string>()
    const called: any[] = []
    const { transport, request } = host({
      'secrets.get': ({ key }) => secrets.get(key) ?? null,
      'secrets.set': ({ key, value }) => void secrets.set(key, value),
      'secrets.delete': ({ key }) => void secrets.delete(key),
      'policy.scope': ({ tool }) => ({ allowed: tool !== 'bash', reason: 'No shell here.' }),
      'policy.authorize': () => null,
      'tools.call': (params) => {
        called.push(params)
        return { ok: true, echoed: params.input }
      }
    })
    const peer = new RpcPeer(transport)
    let gate: { check: (name: string, input: unknown) => Promise<string | null> } | null = null
    let offered: { name: string; execute: (input: Record<string, unknown>) => Promise<unknown> }[] = []
    const harness = createHarness({
      dataRoot: rootWithProject(),
      stateDir: mkdtempSync(join(tmpdir(), 'hs-')),
      secrets: remoteSecrets(peer),
      policy: remotePolicy(peer),
      directory: remoteDirectory(peer),
      sessionFactory: async (input) => {
        gate = input.gate
        offered = input.tools.filter((tool) => input.allow.includes(tool.name))
        return idle()
      }
    })
    open.push(harness)
    harness.sessions.provide(remoteTools(peer))
    attach(harness, peer)

    const { accounts } = await request('accounts.create', { label: 'Main', authKind: 'apiKey' })
    await request('accounts.setApiKey', { accountId: accounts[0].id, key: 'sk-test-0000000000000000', provider: 'anthropic' })
    expect([...secrets.keys()]).toEqual([`${accounts[0].id}/pi-auth/anthropic`])

    await request('directory.set', { agents: { a1: 'Scout' } })
    expect(harness.env.directory.agentName('a1')).toBe('Scout')

    expect(await request('tools.register', { tools: [{ name: 'lookup', description: 'Look something up', parameters: { type: 'object', properties: { q: { type: 'string' } } } }] })).toEqual({ registered: ['lookup'] })
    await request('sessions.run', { run: { id: 'r1', sessionId: 'a1' }, cwd: harness.env.root, sessionDir: join(harness.env.root, 'sessions', 'a1'), text: 'hello', caller: { agentId: 'a1', actor: 'Chat' }, tools: { allow: ['lookup', 'bash'] } })
    expect(offered.map((tool) => tool.name)).toContain('lookup')
    expect(await offered.find((tool) => tool.name === 'lookup')!.execute({ q: 'x' })).toBe('{"ok":true,"echoed":{"q":"x"}}')
    expect(called[0]).toMatchObject({ name: 'lookup', runId: 'r1', sessionId: 'a1', caller: { agentId: 'a1' } })
    expect(await gate!.check('bash', {})).toBe('No shell here.')
    expect(await gate!.check('lookup', {})).toBeNull()
  })
})

describe('variants over the wire', () => {
  it('seeds, edits, validates, restores, and adds a built-in component, then compiles the variant', async () => {
    const builtins = mkdtempSync(join(tmpdir(), 'builtin-'))
    writeFile(join(builtins, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: reviewing a change before it ships\n---\nRead the diff first.\n')
    writeFile(join(builtins, 'rules', 'plain.md'), '---\nname: Plain words\n---\nUse plain words.\n')
    const { transport, request, notices } = host()
    const harness = createHarness({ dataRoot: rootWithProject(), stateDir: mkdtempSync(join(tmpdir(), 'hs-')), secrets: memorySecretStore(), builtins: [builtins] })
    open.push(harness)
    serve(harness, transport)

    const seeded = await request('variants.seed', { scope: 'a1', instructions: 'You help with releases.' })
    expect(seeded.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(notices).toContainEqual({ type: 'variants.changed', scope: 'a1' })
    const first = await request('variants.get', { scope: 'a1' })
    expect(first.variant['systemprompt.md']).toBe('You help with releases.\n')

    const library = await request<any[]>('variants.components')
    expect(library.map((item) => item.id)).toEqual(['rules/plain', 'skills/review'])
    const added = await request('variants.addComponent', { scope: 'a1', id: 'skills/review' })
    expect(added.ok).toBe(true)
    expect(added.variant['guardrails.md']).toContain('load the `review` skill')
    const saved = await request('variants.save', { scope: 'a1', variant: added.variant, note: 'Added review' })
    expect(saved.parent).toBe(seeded.fingerprint)

    const bad = await request('variants.validate', { variant: { ...added.variant, 'plugins/x.ts': 'nothing' } })
    expect(bad).toMatchObject({ ok: false })
    expect(bad.problems.join(' ')).toContain('default export')
    await expect(request('variants.save', { scope: 'a1', edit: { 'plugins/x.ts': 'nothing' } })).rejects.toMatchObject({ code: 'variant_invalid' })

    const edited = await request('variants.save', { scope: 'a1', edit: { 'memory.md': 'Releases ship on Tuesdays.\n' } })
    expect((await request<any[]>('variants.lineage', { scope: 'a1' })).map((version) => version.fingerprint)).toEqual([edited.fingerprint, saved.fingerprint, seeded.fingerprint])
    const compiled = await request('context.compile', { context: { agentId: 'a1', actor: 'Chat' }, variant: { scope: 'a1' }, render: true })
    expect(compiled.text).toContain('Releases ship on Tuesdays.')
    await request('variants.restore', { scope: 'a1', version: seeded.fingerprint })
    expect((await request('variants.get', { scope: 'a1' })).head.fingerprint).toBe(seeded.fingerprint)
    expect(await request('refine.list', { scope: 'a1' })).toEqual([])
  })
})
