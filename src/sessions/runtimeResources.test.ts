import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { resolveWorkspaceRoot } from '../core/workspace'
import { createHarness, type Harness } from '../harness'
import { methods } from '../server/methods'
import { writeFile } from '../../tests/helpers'
import { fauxModel } from '../../tests/faux'
import type { Inventory, Plugin } from '../plugins/types'
import { piSessionFactory } from './runner'

const open: Harness[] = []
afterEach(async () => { for (const harness of open.splice(0)) await harness.close() })

it('attributes discovered resources and tools, respects caller switches, and discards stale observations', async () => {
  const base = mkdtempSync(join(tmpdir(), 'runtime-resources-'))
  const harness = createHarness({ dataRoot: join(base, 'data'), stateDir: join(base, 'state'), secrets: memorySecretStore() })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')
  const account = harness.accounts.context(harness.accounts.resolve(null, null))
  await fauxModel(harness)
  const skill = join(base, 'resources/audit/SKILL.md')
  const prompt = join(base, 'resources/review.md')
  writeFile(skill, '---\nname: runtime-audit\ndescription: Audit at runtime.\n---\nAudit instructions.\n')
  writeFile(prompt, '---\nname: runtime-review\ndescription: Review at runtime.\n---\nReview instructions.\n')
  const extension = join(account.configDir, 'extensions/kit.ts')
  writeFile(extension, `import { Type } from 'typebox'
export default function(pi) {
 pi.registerTool({ name: 'kit_scan', label: 'Scan', description: 'Scan', parameters: Type.Object({}), async execute() { return { content: [], details: {} } } })
 pi.on('resources_discover', () => ({ skillPaths: [${JSON.stringify(skill)}], promptPaths: [${JSON.stringify(prompt)}] }))
}`)
  const table = methods(harness)
  const load = async (agentId: string) => piSessionFactory({ params: { runId: 'r', cwd: base, workspaceRoot: resolveWorkspaceRoot(base), sessionDir: join(base, agentId), historyFile: null, model: null, text: '', account, system: '', update: null,
    plugins: { loading: () => harness.plugins.loading({ cwd: base, agentDir: account.configDir, caller: { agentId } }), loaded: (records) => harness.plugins.loaded(records) } },
    allow: ['read'], tools: [], gate: { check: async () => null }, runtime: () => harness.accounts.runtime(account), extensions: { ask: async () => ({ selected: [] }), notice: () => {} } })
  const first = await load('a1')
  expect(first.systemPrompt).toContain('runtime-audit')
  first.dispose()
  const list = await table['plugins.list']({ cwd: base }) as Plugin[]
  expect(list.find((plugin) => plugin.id === 'shared')?.contributions).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'tool', name: 'kit_scan', state: 'on' }),
    expect.objectContaining({ kind: 'skill', name: 'runtime-audit', path: skill, state: 'on' }),
    expect.objectContaining({ kind: 'command', name: 'runtime-review', path: prompt })
  ]))
  await table['plugins.detach']({ cwd: base, id: 'shared/skill/runtime-audit', scope: { agentId: 'a1' } })
  const off = await load('a1')
  expect(off.systemPrompt).not.toContain('runtime-audit')
  off.dispose()
  const on = await load('a2')
  expect(on.systemPrompt).toContain('runtime-audit')
  on.dispose()
  const inventory = await table['plugins.inventory']({ cwd: base, context: { agentId: 'a2' }, tools: ['read', 'kit_scan'] }) as Inventory
  expect(inventory.items).toEqual(expect.arrayContaining([expect.objectContaining({ pluginId: 'shared', kind: 'tool', name: 'kit_scan' }), expect.objectContaining({ pluginId: 'shared', kind: 'skill', name: 'runtime-audit', chars: expect.any(Number) })]))
  expect(inventory.unattributed).toEqual([])
  expect(inventory.items.filter((entry) => entry.kind === 'tool' && entry.name === 'kit_scan')).toHaveLength(1)
  writeFile(extension, 'export default function() {}\n')
  const changed = await table['plugins.list']({ cwd: base }) as Plugin[]
  expect(changed.find((plugin) => plugin.id === 'shared')?.contributions.some((item) => item.name === 'runtime-audit' || item.name === 'kit_scan')).toBe(false)
})
