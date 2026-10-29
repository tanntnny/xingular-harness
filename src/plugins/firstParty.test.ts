// The harness's own two plugins, run through a real Pi session with a scripted model: nothing
// here is faked on Pi's side except what the model says.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import { methods } from '../server/methods'
import type { RunEvent } from '../sessions/contracts'
import { fauxModel } from '../../tests/faux'
import { rootWithProject, writeFile } from '../../tests/helpers'
import { settingValue, trimText } from './firstParty'
import type { Inventory, Plugin } from './types'

const open: Harness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})

async function setup() {
  const root = rootWithProject()
  const base = mkdtempSync(join(tmpdir(), 'first-party-'))
  // The background upkeep would ask the scripted model too; it is not what is tested here.
  const harness = createHarness({ dataRoot: root, stateDir: join(base, 'state'), secrets: memorySecretStore() })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')
  const model = await fauxModel(harness)
  const events: RunEvent[] = []
  harness.runs.listen((event) => void events.push(event))
  const table = methods(harness)
  const call = <T>(method: string, params: Record<string, unknown> = {}) => table[method](params) as Promise<T>
  let count = 0
  /** One reply: a real session, run until it settles. */
  const reply = async (agentId: string, extra: Record<string, unknown> = {}) => {
    const id = `run-${(count += 1)}`
    await harness.sessions.run({ run: { id, sessionId: agentId }, cwd: base, sessionDir: join(root, 'sessions', agentId), text: 'Go.', model: model.model, caller: { agentId, agentName: 'Helper', actor: 'Chat' }, tools: { allow: ['read'] }, ...extra })
    for (let waited = 0; waited < 200 && !events.some((event) => event.runId === id && (event.type === 'completed' || event.type === 'failed')); waited += 1) await new Promise((resolve) => setTimeout(resolve, 25))
    return events.filter((event) => event.runId === id)
  }
  return { harness, root, base, model, call, reply }
}

describe('Output trim', () => {
  it('keeps the beginning and the end of a long text and says what is missing', () => {
    const text = `${'a'.repeat(700)}${'b'.repeat(4000)}${'c'.repeat(300)}`
    const trimmed = trimText(text, 1000)
    expect(trimmed.startsWith('a'.repeat(700))).toBe(true)
    expect(trimmed.endsWith('c'.repeat(300))).toBe(true)
    expect(trimmed).toContain('4000 of 5000 characters were cut here by the Output trim plugin')
    expect(trimText('short', 1000)).toBe('short')
  })

  it('is off until switched on, then cuts what the model reads, for the agent it is on for', async () => {
    const { base, model, call, reply } = await setup()
    writeFile(join(base, 'big.txt'), `${'START '.repeat(10)}${'x'.repeat(30_000)}${' END'.repeat(10)}`)
    const read = () => model.script([model.calls(['read', { path: join(base, 'big.txt') }]), model.says('Done.')])

    read()
    await reply('a1')
    expect(model.lastToolResults()[0].length).toBeGreaterThan(30_000)

    const listed = await call<Plugin[]>('plugins.attach', { id: 'output-trim', scope: { agentId: 'a1' } })
    expect(listed.find((plugin) => plugin.id === 'output-trim')).toMatchObject({ source: 'builtin', runsCode: true, trust: 'none', required: null, attachment: { global: false, on: { agentIds: ['a1'], projectIds: [] } }, settings: [{ key: 'maxChars', value: 20_000, default: 20_000 }] })
    await call('plugins.configure', { pluginId: 'output-trim', settings: { maxChars: 3000 } })

    read()
    await reply('a1')
    // The conversation continues, so the model is sent the earlier result too; the newest is last.
    const seen = model.lastToolResults().at(-1)!
    expect(seen.length).toBeLessThan(3400)
    expect(seen.startsWith('START START')).toBe(true)
    expect(seen.endsWith('END END')).toBe(true)
    expect(seen).toContain('characters were cut here by the Output trim plugin')

    // Another agent still reads the whole result.
    read()
    await reply('a2')
    expect(model.lastToolResults().at(-1)!.length).toBeGreaterThan(30_000)

    // It reaches the agent it is on for, and is listed as that agent's.
    const inventory = await call<Inventory>('plugins.inventory', { context: { agentId: 'a1' }, tools: ['read'] })
    expect(inventory.items.filter((item) => item.pluginId === 'output-trim').map((item) => [item.kind, item.delivery])).toEqual([['code', 'code']])
    expect((await call<Inventory>('plugins.inventory', { context: { agentId: 'a2' }, tools: ['read'] })).items.some((item) => item.pluginId === 'output-trim')).toBe(false)
  })

  it('also runs in unattended work, where nothing on disk is loaded', async () => {
    const { base, model, call, reply } = await setup()
    writeFile(join(base, 'big.txt'), 'y'.repeat(30_000))
    await call('plugins.attach', { id: 'output-trim' })
    await call('plugins.configure', { pluginId: 'output-trim', settings: { maxChars: 2000 } })
    model.script([model.calls(['read', { path: join(base, 'big.txt') }]), model.says('Done.')])
    await reply('a1', { automatic: true })
    expect(model.lastToolResults()[0]).toContain('were cut here by the Output trim plugin')
  })
})

describe('Budget guard', () => {
  it('refuses tool calls past the limit, gives the agent one request to wrap up, then ends the reply', async () => {
    const { base, model, call, reply } = await setup()
    writeFile(join(base, 'a.txt'), 'line\n'.repeat(40))
    await call('plugins.attach', { id: 'budget-guard' })
    await call('plugins.configure', { pluginId: 'budget-guard', settings: { maxRequests: 5 } })
    // A model that never stops by itself: every reply asks for another read, so nothing but the
    // budget guard is what ends this reply.
    const again = (step: number) => model.calls(['read', { path: join(base, 'a.txt'), offset: step, limit: 1 }])
    model.script(Array.from({ length: 40 }, (_, step) => again(step)))
    const events = await reply('a1')
    const tools = events.filter((event) => event.type === 'tool.completed').map((event) => (event.payload as { ok: boolean }).ok)
    // Four reads run. The fifth request's read is refused and the agent is told to wrap up; it asks
    // again in the sixth, which is refused too, and that ends the reply.
    expect(tools).toEqual([true, true, true, true, false, false])
    expect(model.requests()).toBe(6)
    expect(model.lastToolResults().at(-1)).toContain('reached its limit of 5 model requests (the Budget guard plugin)')
    expect(events.at(-1)?.type).toBe('completed')
  })

  it('lets a reply that wraps up when told finish in its own words', async () => {
    const { base, model, call, reply } = await setup()
    writeFile(join(base, 'a.txt'), 'line\n'.repeat(40))
    await call('plugins.attach', { id: 'budget-guard' })
    await call('plugins.configure', { pluginId: 'budget-guard', settings: { maxRequests: 5 } })
    const again = (step: number) => model.calls(['read', { path: join(base, 'a.txt'), offset: step, limit: 1 }])
    model.script([again(0), again(1), again(2), again(3), again(4), model.says('I read the file four times; one more read is left.')])
    const events = await reply('a1')
    expect(model.requests()).toBe(6)
    expect(events.filter((event) => event.type === 'message.completed').map((event) => (event.payload as { text: string }).text).at(-1)).toBe('I read the file four times; one more read is left.')
  })

  it('does nothing while it is switched off, and takes only numbers inside its range', async () => {
    const { base, model, call, reply } = await setup()
    writeFile(join(base, 'a.txt'), 'line\n'.repeat(40))
    const again = (step: number) => model.calls(['read', { path: join(base, 'a.txt'), offset: step, limit: 1 }])
    model.script([...Array.from({ length: 8 }, (_, step) => again(step)), model.says('Done.')])
    const events = await reply('a1')
    expect(events.filter((event) => event.type === 'tool.completed').every((event) => (event.payload as { ok: boolean }).ok)).toBe(true)
    await expect(call('plugins.configure', { pluginId: 'budget-guard', settings: { maxRequests: 1 } })).rejects.toThrow('must be a number from 5 to 2000')
    await expect(call('plugins.configure', { pluginId: 'budget-guard', settings: { speed: 3 } })).rejects.toThrow('has no setting called "speed"')
    await expect(call('plugins.configure', { pluginId: 'memory', settings: {} })).rejects.toThrow('has no settings')
    expect(settingValue({ key: 'k', label: '', description: '', default: 60, min: 5, max: 100 }, { k: 1000 })).toBe(60)
    expect(settingValue({ key: 'k', label: '', description: '', default: 60, min: 5, max: 100 }, { k: 80.9 })).toBe(80)
  })
})
