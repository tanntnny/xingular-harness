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
  it('answers by method name, reports failures with their code, and forwards events and notices', async () => {
    const { transport, request, events, notices } = host()
    const harness = createHarness({ dataRoot: rootWithProject(), stateDir: mkdtempSync(join(tmpdir(), 'hs-')), secrets: memorySecretStore(), sessionFactory: async () => idle() })
    open.push(harness)
    serve(harness, transport)

    const status = await request('harness.status')
    expect(status).toMatchObject({ dataRoot: harness.env.root, productName: 'Xingular Harness', activeRuns: [] })
    expect(await request<string[]>('harness.methods')).toEqual(expect.arrayContaining(['accounts.list', 'sessions.run', 'wiki.pages', 'terminal.prepare', 'skills.list', 'connections.list', 'harness.shutdown']))

    const overview = await request('accounts.create', { label: 'Main', authKind: 'apiKey' })
    expect(overview.accounts).toHaveLength(1)
    expect(notices).toContainEqual(expect.objectContaining({ type: 'accounts.changed' }))
    await expect(request('accounts.rename', { accountId: 'nope', label: 'x' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(request('accounts.rename', {})).rejects.toMatchObject({ code: 'invalid_request', message: 'accountId is required.' })
    await expect(request('nope.nothing')).rejects.toMatchObject({ code: 'unknown_method' })

    expect((await request<any[]>('wiki.namespaces')).map((entry) => entry.namespace)).toEqual(expect.arrayContaining(['/projects/app']))
    const blocks = await request<any[]>('blocks.list', { agentIds: ['a1'] })
    expect(blocks.map((block) => block.label)).toEqual(expect.arrayContaining(['user', 'persona', 'notes']))
    expect(await request('memory.call', { context: { agentId: 'a1', agentName: 'Helper', actor: 'Chat' }, call: 'memory.append', params: { block: 'notes', text: 'Ship on Fridays.' } })).toContain('notes')
    expect(notices).toContainEqual({ type: 'wiki.changed' })
    const compiled = await request('context.compile', { context: { agentId: 'a1', agentName: 'Helper', actor: 'Chat' }, render: true })
    expect(compiled.text).toContain('Ship on Fridays.')
    expect(await request('context.profiles')).toEqual({ profiles: {}, stats: [] })

    const started = await request('sessions.run', { run: { id: 'r1', sessionId: 'a1' }, cwd: harness.env.root, sessionDir: join(harness.env.root, 'sessions', 'a1'), text: 'hello', caller: { agentId: 'a1', agentName: 'Helper', actor: 'Chat' }, tools: { allow: ['read'] } })
    expect(started).toEqual({ runId: 'r1', nativeSessionId: 'native-1' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(events.map((event) => event.type)).toEqual(['started', 'status.changed', 'context.snapshot', 'completed'])
    expect((await request('runs.load', { runId: 'r1' })).run).toMatchObject({ id: 'r1', status: 'completed' })
    expect((await request<any[]>('runs.list', { filter: { sessionId: 'a1' } })).map((run) => run.id)).toEqual(['r1'])
    expect((await request('context.profiles')).stats).toMatchObject([{ subject: 'a1', mode: 'chat', contextProfile: 'full', runs: 1, completed: 1, runIds: ['r1'] }])
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

describe('built-in skills', () => {
  it('are on everywhere until switched off, and a person\'s own item of the same name replaces one', async () => {
    const builtins = mkdtempSync(join(tmpdir(), 'builtin-'))
    writeFile(join(builtins, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review a change before it ships\n---\nRead the diff first.\n')
    writeFile(join(builtins, 'rules', 'plain.md'), '---\nname: Plain words\ndescription: Write plainly\n---\nUse plain words.\n')
    const { transport, request } = host()
    const harness = createHarness({ dataRoot: rootWithProject(), stateDir: mkdtempSync(join(tmpdir(), 'hs-')), secrets: memorySecretStore(), builtins: [builtins] })
    open.push(harness)
    serve(harness, transport)

    const state = await request('skills.list')
    expect(state.items).toMatchObject([{ id: 'rules/plain', builtin: true }, { id: 'skills/review', builtin: true }])
    expect(state.enabled.global).toEqual(['rules/plain', 'skills/review'])
    expect((await request<any[]>('skills.enabledFor', { projectId: 'p1' })).map((item) => item.id)).toEqual(['rules/plain', 'skills/review'])
    expect((await request('context.compile', { context: { projectId: 'p1', actor: 'Code' }, render: true })).text).toContain('Use plain words.')

    const off = await request('skills.setEnabled', { projectId: null, ids: ['skills/review'] })
    expect(off.enabled).toMatchObject({ global: ['skills/review'], builtinOff: ['rules/plain'] })
    expect((await request<any[]>('skills.enabledFor', {})).map((item) => item.id)).toEqual(['skills/review'])

    writeFile(join(harness.env.root, 'registry', 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: My own review steps\n---\nMine.\n')
    const mine = (await request('skills.list')).items.find((item: any) => item.id === 'skills/review')
    expect(mine).toMatchObject({ description: 'My own review steps' })
    expect(mine.builtin).toBeUndefined()
    // A person's own item is enabled the usual way, not by default.
    expect((await request<any[]>('skills.enabledFor', {})).map((item) => item.id)).toEqual([])
  })
})
