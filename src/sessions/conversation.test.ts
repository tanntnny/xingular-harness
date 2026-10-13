// Whole replies, through everything the harness does for one: the compiled prompt, the plugins
// it chose to load, the gate, the run's events. Pi is real and so are the extensions; only the
// model is scripted, so no request leaves the machine.
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import { listInbox } from '../memory/operations'
import { wikiDir } from '../memory/store'
import type { Plugin } from '../plugins/types'
import { methods } from '../server/methods'
import { fauxModel } from '../../tests/faux'
import { rootWithProject, writeFile } from '../../tests/helpers'
import type { RunEvent } from './contracts'

const open: Harness[] = []
afterEach(async () => {
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
  const harness = createHarness({ dataRoot: root, stateDir: join(base, 'state'), secrets: memorySecretStore(), maintainerFactory: async () => ({ prompt: async () => undefined, dispose: () => undefined, error: () => null }) })
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
  it('dispatches a registered command with notes without making a provider request', async () => {
    const { harness, model, start, until, settled, of } = await setup()
    const account = harness.accounts.context(harness.accounts.resolve(null, null))
    writeFile(join(account.configDir, 'extensions/command.ts'), `export default function(pi) { pi.registerCommand('hello', { description: 'Hello', handler: async (args, ctx) => ctx.ui.notify('hello ' + args) }) }`)
    const id = await start({ text: '/hello original arguments', preamble: '[A note for the next request]' })
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

  it('lets the agent propose a plugin, which reaches the Inbox and nothing else', async () => {
    const { root, model, start, until, settled, of } = await setup()
    model.script([
      model.calls(['plugin_propose', { name: 'Memory to Docs', description: 'Copies each saved memory to the team document.', extends: ['memory'] as never, files: [{ path: 'hooks.mjs', content: "export default function (harness) { harness.on('memory.saved', async () => {}) }\n" }] as never }]),
      model.says('I proposed it; it is in your Inbox.')
    ])
    const id = await start()
    await until(() => settled(id))
    expect(model.lastToolResults().at(-1)).toContain('The plugin "memory-to-docs" is waiting in the Inbox')
    expect(listInbox(wikiDir(root)).map((item) => item.title)).toEqual(['Proposed plugin "Memory to Docs"'])
    expect(existsSync(join(root, 'plugins'))).toBe(false)
    // Proposing is not something a person is asked to approve: it changes nothing until they accept.
    expect(of(id).some((event) => event.type === 'approval.requested')).toBe(false)
  })

  it('has no plugin proposal tool in unattended work', async () => {
    const { model, start, until, settled } = await setup()
    model.script([model.calls(['plugin_propose', { name: 'x', description: 'y', files: [] as never }]), model.says('Done.')])
    const id = await start({ automatic: true })
    await until(() => settled(id))
    expect(model.lastToolResults().at(-1)).not.toContain('waiting in the Inbox')
  })
})
