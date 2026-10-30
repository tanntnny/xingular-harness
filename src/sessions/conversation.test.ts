// Whole replies, through everything the harness does for one: the compiled prompt, the plugins
// it chose to load, the gate, the run's events. Pi is real and so are the extensions; only the
// model is scripted, so no request leaves the machine.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import type { Plugin } from '../plugins/types'
import { methods } from '../server/methods'
import { fauxModel } from '../../tests/faux'
import { rootWithProject, writeFile } from '../../tests/helpers'
import type { RunEvent } from './contracts'

const open: Harness[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const harness of open.splice(0)) await harness.close()
})

const EXTENSION = `import { Type } from 'typebox'
export default function (pi) {
  pi.registerTool({ name: 'kit_scan', label: 'Scan', description: 'Scan a folder.', parameters: Type.Object({ path: Type.String() }), async execute(id, input, signal, onUpdate, ctx) {
    ctx.ui.notify('Scanning ' + input.path, 'info')
    return { content: [{ type: 'text', text: 'scanned ' + input.path }], details: undefined }
  } })
}
`

async function setup() {
  const root = rootWithProject()
  const base = mkdtempSync(join(tmpdir(), 'conversation-'))
  const harness = createHarness({ dataRoot: root, stateDir: join(base, 'state'), secrets: memorySecretStore() })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')
  const model = await fauxModel(harness)
  const events: RunEvent[] = []
  harness.runs.listen((event) => void events.push(event))
  const table = methods(harness)
  const call = <T>(method: string, params: Record<string, unknown> = {}) => table[method](params) as Promise<T>
  const settled = (id: string) => events.some((event) => event.runId === id && (event.type === 'completed' || event.type === 'failed'))
  const until = async (done: () => boolean) => {
    for (let waited = 0; waited < 400 && !done(); waited += 1) await new Promise((resolve) => setTimeout(resolve, 25))
  }
  let count = 0
  const start = async (extra: Record<string, unknown> = {}) => {
    const id = `run-${(count += 1)}`
    await harness.sessions.run({ run: { id, sessionId: 'a1' }, cwd: base, sessionDir: join(root, 'sessions', 'a1'), text: 'Go.', model: model.model, caller: { agentId: 'a1', agentName: 'Helper', actor: 'Chat' }, tools: { allow: ['read'] }, ...extra })
    return id
  }
  const of = (id: string) => events.filter((event) => event.runId === id)
  return { harness, root, base, model, call, start, until, settled, of }
}

describe('a whole reply, with a scripted model', () => {
  // ADR-0069: the stop gate through real Pi. Pi must accept the gate's continuation, the model must
  // see the nudge, and the run must settle honestly.
  const status = (of: (id: string) => RunEvent[], id: string) =>
    of(id).filter((event) => event.type === 'completed' || event.type === 'failed' || (event.type === 'status.changed' && (event.payload as { status: string }).status === 'interrupted')).at(-1)

  it('sends a reply that ends with open todo items back to the model, which then finishes the work', async () => {
    const { root, model, start, until, of } = await setup()
    const todo = (first: string, second: string) => model.calls(['todo_write', { items: [{ text: 'Port the auth route', status: first }, { text: 'Port the courses route', status: second }] } as never])
    model.script([todo('in_progress', 'pending'), model.says('Auth is ported; the rest can wait.'), todo('completed', 'completed'), model.says('Both routes are ported.')])
    const id = await start()
    await until(() => Boolean(status(of, id)))
    expect(model.requests()).toBe(4)
    expect(model.lastUserTexts().some((text) => text.includes('Harness stop gate (1/3)') && text.includes('- Port the courses route'))).toBe(true)
    expect(status(of, id)?.type).toBe('completed')
    expect(of(id).filter((event) => event.type === 'extension.notice' && (event.payload as { extension?: string }).extension === 'stop-gate')).toHaveLength(1)
    const { loadRun } = await import('./runStore')
    expect(loadRun(root, id)).toMatchObject({ status: 'completed', terminalReason: null })
  })

  it('hands a reply back as unfinished when the nudge produces no work', async () => {
    const { root, model, start, until, of } = await setup()
    model.script([
      model.calls(['todo_write', { items: [{ text: 'Run the migration', status: 'pending' }] } as never]),
      model.says('Stopping here.'),
      model.says('Still stopping.')
    ])
    const id = await start()
    await until(() => Boolean(status(of, id)))
    expect(model.requests()).toBe(3)
    const { loadRun } = await import('./runStore')
    expect(loadRun(root, id)).toMatchObject({ status: 'interrupted', terminalReason: 'unfinished', terminalCode: 'unfinished' })
    expect(of(id).find((event) => event.type === 'checkpoint')?.payload).toMatchObject({ next: 'Run the migration', summary: 'Still stopping.', reason: 'stuck' })
  })

  // ADR-0071: the completion check through real Pi. One scripted model answers both the agent and the
  // check; a check request is told apart by its system prompt.
  const routed = (model: Awaited<ReturnType<typeof fauxModel>>, agent: unknown[], check: string[]) => {
    const isCheck = (context: { messages?: { role: string; content: unknown }[] }) => {
      const last = context.messages?.at(-1)
      const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
      return last?.role === 'user' && text.includes("## The person's request")
    }
    const step = (context: { messages?: { role: string; content: unknown }[] }) => isCheck(context)
      ? model.says(check.shift() ?? '{"verdict":"done","reason":"ok"}')
      : agent.shift() ?? model.says('Done.')
    model.script(Array(agent.length + check.length + 2).fill(step))
  }

  it('sends back a reply whose closed todo list hides unfinished work, and ends it once the check says done', async () => {
    vi.stubEnv('XINGULAR_COMPLETION_CHECK', 'on')
    const { root, model, start, until, of } = await setup()
    routed(model, [
      model.calls(['read', { path: 'src' }]),
      model.calls(['todo_write', { items: [{ text: 'Implement B0', status: 'completed' }] } as never]),
      model.says('B0 is done. Should I start B1 next?'),
      model.calls(['read', { path: 'src' }]),
      model.says('B1 is done too.')
    ], [
      '{"verdict":"continue","reason":"The handoff asks for B0 and B1; the order is already decided.","next":"Start B1."}',
      '{"verdict":"done","reason":"B0 and B1 are done.","next":""}'
    ])
    const id = await start({ text: 'Implement B0 and B1 of the handoff.', launch: { standard: { cwd: root } } })
    await until(() => Boolean(status(of, id)))
    expect(model.requests()).toBe(7)
    const notices = of(id).filter((event) => event.type === 'extension.notice').map((event) => (event.payload as { text: string }).text)
    expect(notices).toEqual(['Completion check 1: continue — The handoff asks for B0 and B1; the order is already decided.', 'Completion check 2: done — B0 and B1 are done.'])
    const { loadRun } = await import('./runStore')
    expect(loadRun(root, id)).toMatchObject({ status: 'completed', terminalReason: null })
    // The check's two requests are counted with the run's own.
    expect((of(id).filter((event) => event.type === 'usage.updated').at(-1)?.payload as { requests: number }).requests).toBe(7)
  })

  it('lets the check, not the doer, stop a reply for the person', async () => {
    vi.stubEnv('XINGULAR_COMPLETION_CHECK', 'on')
    const { root, model, start, until, of } = await setup()
    routed(model, [model.calls(['read', { path: 'src' }]), model.says('The cutover is ready; it moves the production route.')], ['{"verdict":"needs_person","reason":"Moving the production route needs the person\'s approval.","next":""}'])
    const id = await start({ text: 'Prepare and run the API cutover.' })
    await until(() => Boolean(status(of, id)))
    const { loadRun } = await import('./runStore')
    expect(loadRun(root, id)).toMatchObject({ status: 'interrupted', terminalCode: 'needs_person' })
    expect(of(id).find((event) => event.type === 'checkpoint')?.payload).toMatchObject({ blocked: 'Moving the production route needs the person\'s approval.', reason: 'requested' })
  })

  it('never checks a reply that did no work', async () => {
    vi.stubEnv('XINGULAR_COMPLETION_CHECK', 'on')
    const { root, model, start, until, of } = await setup()
    model.script([model.says('B0 covers the workspace and CI.')])
    const id = await start({ text: 'What does B0 cover?' })
    await until(() => Boolean(status(of, id)))
    expect(model.requests()).toBe(1)
    const { loadRun } = await import('./runStore')
    expect(loadRun(root, id)).toMatchObject({ status: 'completed' })
  })

  it('joins async native children and persists one result receipt before the final reply', async () => {
    const { harness, root, model, start, until, settled, of } = await setup()
    const route = (context: { messages: Array<{ role: string; content: unknown }> }) => {
      const users = context.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : (message.content as Array<{ text?: string }>).map(part => part.text ?? '').join(''))
      if (users.includes('native-child-brief')) return model.says('CHILD_EVIDENCE')
      if (JSON.stringify(context.messages).includes('CHILD_EVIDENCE')) return model.says('Final with CHILD_EVIDENCE')
      if (!context.messages.some(message => message.role === 'toolResult')) return model.calls(['spawn_subagent', { title: 'Run native child', brief: 'native-child-brief' }])
      return model.says('Draft before joining')
    }
    model.script(Array(8).fill(route))
    const id = await start()
    await until(() => settled(id))
    expect(of(id).at(-1)?.type).toBe('completed')
    expect(of(id).filter(event => event.type === 'message.completed').at(-1)?.payload).toMatchObject({ text: 'Final with CHILD_EVIDENCE' })
    const { sessionFile } = await import('../prompt/compile')
    const { readFileSync } = await import('node:fs')
    const entries = readFileSync(sessionFile(join(root, 'sessions', 'a1'))!, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(entries.filter(entry => entry.customType === 'xingular-subagent-results')).toHaveLength(1)
    expect(model.requests()).toBeLessThanOrEqual(4)
    expect(harness.runs.activeRunIds()).toEqual([])
  })

  it('uses blocking native results without adding an unsolicited duplicate delivery', async () => {
    const { root, model, start, until, settled, of } = await setup()
    model.script([model.calls(['spawn_subagent', { title: 'Find proof', brief: 'Find proof', wait: true }]), model.says('INLINE_CHILD_PROOF'), model.says('Final')])
    const id = await start()
    await until(() => settled(id))
    expect(of(id).at(-1)?.type).toBe('completed')
    expect(model.lastToolResults().join('')).toContain('INLINE_CHILD_PROOF')
    const { sessionFile } = await import('../prompt/compile')
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(sessionFile(join(root, 'sessions', 'a1'))!, 'utf8')).not.toContain('"customType":"xingular-subagent-results"')
    expect(model.requests()).toBe(3)
  })

  it('interrupts a parent waiting on a child approval without deadlocking SDK abort', async () => {
    const { harness, model, start, until, settled } = await setup()
    const ai = await import('@earendil-works/pi-ai')
    model.script([
      model.calls(['spawn_subagent', { title: 'Run gated command', brief: 'Run a gated command', wait: true }]),
      ai.fauxAssistantMessage([ai.fauxToolCall('bash', { command: 'echo approval' })], { stopReason: 'toolUse' })
    ])
    let childRunId: string | null = null
    harness.runs.listen((event, run) => { if (event.type === 'approval.requested' && run?.relation === 'subagent') childRunId = event.runId })
    const id = await start({ tools: { allow: ['read', 'bash'], gated: ['bash'] } })
    await until(() => childRunId !== null || settled(id))
    expect(childRunId).not.toBeNull()
    await harness.runs.interrupt(id)
    const { loadRun, readEvents } = await import('./runStore')
    expect(loadRun(harness.env.root, id).status).toBe('interrupted')
    expect(loadRun(harness.env.root, childRunId!).status).toBe('interrupted')
    expect(readEvents(harness.env.root, childRunId!).some(event => event.type === 'approval.resolved')).toBe(true)
    expect(harness.runs.activeRunIds()).toEqual([])
  })

  it('dispatches a registered command with notes without making a provider request', async () => {
    const { harness, model, start, until, settled, of } = await setup()
    const account = harness.accounts.context(harness.accounts.resolve(null, null))
    writeFile(join(account.configDir, 'extensions/command.ts'), `export default function(pi) { pi.registerCommand('hello', { description: 'Hello', handler: async (args, ctx) => ctx.ui.notify('hello ' + args) }) }`)
    const id = await start({ text: '/command:hello original arguments', preamble: '[A note for the next request]' })
    await until(() => settled(id))
    expect(of(id).at(-1)?.type).toBe('completed')
    expect(of(id).find((event) => event.type === 'extension.notice')?.payload).toMatchObject({ text: 'hello original arguments' })
    expect(model.requests()).toBe(0)
  })

  it('asks before an extension tool that uses the name of an allowed native read', async () => {
    const { harness, model, start, until, settled, of } = await setup()
    const account = harness.accounts.context(harness.accounts.resolve(null, null))
    writeFile(join(account.configDir, 'extensions/override.ts'), EXTENSION.replaceAll('kit_scan', 'read'))
    model.script([model.calls(['read', { path: 'src' }]), model.says('Done.')])
    const id = await start()
    await until(() => of(id).some((event) => event.type === 'approval.requested') || settled(id))
    const approval = of(id).find((event) => event.type === 'approval.requested')?.payload as { approvalId: string; target: string }
    expect(approval?.target).toBe('read')
    expect(of(id).some((event) => event.type === 'extension.notice')).toBe(false)
    harness.runs.resolveApproval(id, approval.approvalId, 'denied')
    await until(() => settled(id))
    expect(model.lastToolResults().at(-1)).toContain('denied')
    expect(of(id).some((event) => event.type === 'extension.notice')).toBe(false)
  })

  it("offers an installed plugin's tool only once the plugin is switched on and trusted, and asks before the tool runs", async () => {
    const { harness, base, model, call, start, until, settled, of } = await setup()
    writeFile(join(base, 'kit/package.json'), JSON.stringify({ name: 'review-kit', version: '1.0.0', description: 'Review helpers.' }))
    writeFile(join(base, 'kit/extensions/scan.ts'), EXTENSION)
    const plugin = (await call<Plugin[]>('plugins.install', { source: join(base, 'kit') })).find((candidate) => candidate.id === 'package:review-kit')!
    const scan = () => model.script([model.calls(['kit_scan', { path: 'src' }]), model.says('Scanned.')])

    // Installed, switched off, untrusted: the model names a tool the session does not have.
    scan()
    const first = await start()
    await until(() => settled(first))
    expect(of(first).some((event) => event.type === 'approval.requested')).toBe(false)
    expect(model.lastToolResults().at(-1)).toMatch(/kit_scan/)
    expect(model.lastToolResults().at(-1)).not.toContain('scanned src')

    await call('plugins.attach', { id: plugin.id })
    await call('plugins.trust', { hash: plugin.code!.hash })
    scan()
    const second = await start()
    await until(() => of(second).some((event) => event.type === 'approval.requested') || settled(second))
    const approval = of(second).find((event) => event.type === 'approval.requested')!.payload as { approvalId: string; target: string }
    expect(approval.target).toBe('kit_scan')
    // Nothing ran while the person was deciding.
    expect(of(second).some((event) => event.type === 'extension.notice')).toBe(false)
    harness.runs.resolveApproval(second, approval.approvalId, 'approved')
    await until(() => settled(second))
    expect(model.lastToolResults().at(-1)).toBe('scanned src')
    // What the extension told the person arrived as a run event.
    expect(of(second).find((event) => event.type === 'extension.notice')?.payload).toEqual({ kind: 'notify', level: 'info', text: 'Scanning src' })
    expect(of(second).at(-1)?.type).toBe('completed')
    // Having loaded once, the plugin's details say what its extension adds.
    expect((await call<Plugin[]>('plugins.list')).find((candidate) => candidate.id === plugin.id)!.contributions[0].description).toBe('Adds tools kit_scan.')

    // Denied, the tool does not run and the model is told.
    scan()
    const third = await start()
    await until(() => of(third).some((event) => event.type === 'approval.requested') || settled(third))
    harness.runs.resolveApproval(third, (of(third).find((event) => event.type === 'approval.requested')!.payload as { approvalId: string }).approvalId, 'denied')
    await until(() => settled(third))
    expect(model.lastToolResults().at(-1)).toMatch(/denied/)
  })

  it('delivers a message sent during a tool call after that call, before the next request', async () => {
    const { harness, model, call, start, until, settled, of } = await setup()
    model.script([model.calls(['bash', { command: 'ls' }]), model.says('Noted.')])
    const id = await start({ tools: { allow: ['read', 'bash'], gated: ['bash'] } })
    await until(() => of(id).some((event) => event.type === 'approval.requested'))
    const approval = of(id).find((event) => event.type === 'approval.requested')!.payload as { approvalId: string }
    await call('runs.steer', { runId: id, text: 'Also check the logs.' })
    harness.runs.resolveApproval(id, approval.approvalId, 'denied')
    await until(() => settled(id))
    const types = of(id).map((event) => event.type)
    expect(of(id).find((event) => event.type === 'message.steered')?.payload).toEqual({ text: 'Also check the logs.' })
    expect(types.indexOf('message.steered')).toBeGreaterThan(types.indexOf('approval.resolved'))
    expect(model.requests()).toBe(2)
    // The context update reaches the model as a user-role message too; the prompt and the steer come last.
    expect(model.lastUserTexts().slice(-2)).toEqual(['Go.', 'Also check the logs.'])
    expect(of(id).at(-1)?.type).toBe('completed')
  })

  it('refuses a message once the reply has ended, so the app sends it as a new reply', async () => {
    const { call, model, start, until, settled, of } = await setup()
    model.script([model.says('Done.')])
    const id = await start()
    await until(() => settled(id))
    await expect(call('runs.steer', { runId: id, text: 'Too late.' })).rejects.toMatchObject({ code: 'run_not_active' })
    expect(of(id).some((event) => event.type === 'message.steered')).toBe(false)
  })
})
