// A real Pi session with a real extension, and no provider: nothing here makes a model request.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import { writeFile } from '../../tests/helpers'
import type { ExtensionNotice } from './extensionUi'
import type { QuestionInput } from './registry'
import { piSessionFactory, type TurnParams } from './runner'

const open: Harness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})

const EXTENSION = `import { Type } from 'typebox'
export default function (pi) {
  pi.registerTool({ name: 'kit_scan', label: 'Scan', description: 'Scan a folder.', parameters: Type.Object({ path: Type.String() }), async execute() { return { content: [{ type: 'text', text: 'scanned' }], details: undefined } } })
  pi.registerCommand('hello', { description: 'Says hello', handler: async (args, ctx) => {
    const sure = await ctx.ui.confirm('Say hello?', args)
    ctx.ui.notify(sure ? 'hello ' + args : 'kept quiet', 'info')
  } })
  pi.on('session_start', async (_event, ctx) => { ctx.ui.setStatus('kit', 'ready in ' + ctx.mode) })
}
`

it('binds an extension in a session without a terminal: its start hook runs, its tool is offered and asks, its command can ask and tell', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ext-session-'))
  const harness = createHarness({ dataRoot: join(base, 'data'), stateDir: join(base, 'state'), secrets: memorySecretStore() })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')
  const account = harness.accounts.context(harness.accounts.resolve(null, null))
  writeFile(join(account.configDir, 'extensions/kit.ts'), EXTENSION)

  const notices: ExtensionNotice[] = []
  const asked: QuestionInput[] = []
  const gated: string[] = []
  const params: TurnParams = {
    runId: 'r1',
    cwd: base,
    sessionDir: join(base, 'sessions'),
    historyFile: null,
    model: null,
    text: '',
    account,
    system: '',
    update: null,
    plugins: { loading: () => harness.plugins.loading({ cwd: base, agentDir: account.configDir }), loaded: (extensions) => harness.plugins.loaded(extensions) }
  }
  const session = await piSessionFactory({
    params,
    allow: ['read'],
    gate: { check: async () => null, ask: (names) => void gated.push(...names) },
    tools: [],
    runtime: () => harness.accounts.runtime(account),
    extensions: { ask: async (input) => (asked.push(input), { selected: ['Yes'] }), notice: (notice) => void notices.push(notice) }
  })
  try {
    expect(notices).toEqual([{ kind: 'status', key: 'kit', text: 'ready in rpc' }])
    expect(gated).toEqual(['kit_scan'])
    expect(session.getActiveToolNames?.()).toEqual(expect.arrayContaining(['read', 'kit_scan']))
    expect(session.getActiveToolNames?.()).not.toContain('bash')

    await session.prompt('/hello there')
    expect(asked).toEqual([{ question: 'Say hello?\n\nthere', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false, allowText: false }])
    expect(notices.at(-1)).toEqual({ kind: 'notify', level: 'info', text: 'hello there' })
    expect(Object.values(harness.plugins.registered())[0]).toMatchObject({ tools: ['kit_scan'], commands: ['hello'], hooks: ['session_start'] })
  } finally {
    session.dispose()
  }
})
