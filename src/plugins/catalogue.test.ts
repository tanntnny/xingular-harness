import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import { methods } from '../server/methods'
import { HARNESS_TOOLS } from '../tools/definitions'
import { WEB_PLUGIN } from '../web/tools'
import { rootWithProject, writeFile } from '../../tests/helpers'
import { HARNESS_PLUGINS } from './builtin'
import type { Found } from './discover'
import type { Inventory, Plugin, PluginDescriptor } from './types'

const open: Harness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})

const APP_PLUGINS: PluginDescriptor[] = [
  WEB_PLUGIN,
  { id: 'app-identity', title: 'Identity and roles', description: 'Who the agent is.', required: 'It names the agent.', sections: [{ id: 'identity', name: 'Identity line' }] },
  { id: 'app-tasks', title: 'Tasks', description: 'Hands work to other sessions.', tools: [{ name: 'start_task', description: 'Start a task' }], toolGroups: ['Tasks'] }
]

function setup() {
  const root = rootWithProject()
  writeFile(join(root, 'registry/rules/tests.md'), '---\nname: Run tests\ndescription: Always test.\n---\nAlways run the test suite before finishing.\n')
  writeFile(join(root, 'registry/skills/release/SKILL.md'), '---\nname: Release notes\ndescription: Write release notes from commits.\n---\nSteps.\n')
  writeFile(join(root, 'registry/prompts/review.md'), 'Review this change.\n')
  writeFile(join(root, 'registry/skills/unused.md'), '# Unused\n')
  writeFile(join(root, 'config/registry-enabled.json'), JSON.stringify({ global: ['rules/tests'], p1: ['skills/release', 'prompts/review'] }))
  const base = mkdtempSync(join(tmpdir(), 'catalogue-'))
  const cwd = join(base, 'project')
  writeFile(join(cwd, '.pi/extensions/local.ts'), 'export default function () {}\n')
  writeFile(join(cwd, 'AGENTS.md'), 'Use tabs.\n')
  writeFile(join(base, 'package/package.json'), JSON.stringify({ name: 'review-kit', description: 'Review helpers.', version: '1.2.0' }))
  writeFile(join(base, 'package/extensions/guard.ts'), 'export default function () {}\n')
  writeFile(join(base, 'package/skills/audit/SKILL.md'), '---\nname: audit\ndescription: Audit a change.\n---\nSteps.\n')
  writeFile(join(base, 'home/.agents/skills/deploy/SKILL.md'), '---\nname: deploy\ndescription: Deploy a site.\n---\nSteps.\n')
  const item = (kind: Found['kind'], path: string, origin: Found['origin'], rest: Partial<Found> = {}): Found => ({ kind, path, origin, project: origin === 'project', packageRoot: null, source: null, enabled: true, ...rest })
  const found: Found[] = [
    item('extension', join(cwd, '.pi/extensions/local.ts'), 'project'),
    item('context', join(cwd, 'AGENTS.md'), 'project'),
    item('extension', join(base, 'package/extensions/guard.ts'), 'package', { packageRoot: join(base, 'package'), source: 'npm:review-kit' }),
    item('skill', join(base, 'package/skills/audit/SKILL.md'), 'package', { packageRoot: join(base, 'package'), source: 'npm:review-kit' }),
    item('skill', join(base, 'home/.agents/skills/deploy/SKILL.md'), 'home'),
    item('extension', 'builtin:mcp', 'builtin'),
    item('extension', 'builtin:llama.cpp', 'builtin', { enabled: false })
  ]
  const harness = createHarness({ dataRoot: root, stateDir: mkdtempSync(join(tmpdir(), 'hs-')), secrets: memorySecretStore(), plugins: APP_PLUGINS, resolver: async () => found })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')
  const call = methods(harness)
  return { harness, root, cwd, base, call: <T>(method: string, params: Record<string, unknown> = {}) => call[method](params) as Promise<T> }
}

const summary = (plugins: Plugin[]) => plugins.map((plugin) => [plugin.id, plugin.source, plugin.contributions.map((entry) => `${entry.kind}:${entry.name}:${entry.state}`)])

describe('the plugin list', () => {
  it('has every source as bundles, with what each contributes and who it is on for', async () => {
    const { call, cwd, base, harness } = setup()
    const loading = await harness.plugins.loading({ cwd, agentDir: harness.accounts.context(harness.accounts.resolve(null, null)).configDir })
    harness.plugins.loaded([{ path: join(base, 'package/extensions/guard.ts'), hash: loading.packageCode[join(base, 'package')].hash, hooks: ['tool_call'], tools: [], commands: ['guard'], flags: [], shortcuts: [] }])
    const plugins = await call<Plugin[]>('plugins.list', { cwd })
    expect(summary(plugins.filter((plugin) => !['builtin', 'pi'].includes(plugin.source)))).toEqual([
      ['project', 'project', ['code:local.ts:untrusted', 'instruction:AGENTS.md:on']],
      ['package:review-kit', 'package', ['code:guard.ts:on', 'command:guard:on', 'skill:audit:on']],
      ['home', 'home', ['skill:deploy:on']],
      ['app-identity', 'application', ['instruction:Identity line:on']],
      ['app-tasks', 'application', ['tool:start_task:on']]
    ])
    expect(plugins.filter((plugin) => plugin.source === 'builtin').map((plugin) => plugin.id)).toEqual(['ask-user', 'browser', 'budget-guard', 'capabilities', 'checklist', 'checkpoint', 'connected-apps', 'doctor', 'history', 'hub', 'lessons', 'output-trim', 'refinement', 'side-questions', 'subagents', 'usage', 'variant', 'web', 'annotations', 'wiki', 'worktrees'])
    // An application that still describes the web tools is ignored: they are the harness's own now.
    expect(plugins.find((plugin) => plugin.id === 'web')?.source).toBe('builtin')

    const kit = plugins.find((plugin) => plugin.id === 'package:review-kit')!
    // It was there when trust was first asked per package, so it was taken over as trusted.
    expect(kit).toMatchObject({ title: 'review-kit', description: 'Review helpers.', version: '1.2.0', runsCode: true, trust: 'trusted', code: { files: ['extensions/guard.ts', 'package.json', 'skills/audit/SKILL.md'] }, path: join(base, 'package') })
    expect(kit.contributions[0].description).toBe('Adds commands /guard; hooks tool_call.')
    const project = plugins.find((plugin) => plugin.id === 'project')!
    expect(project).toMatchObject({ runsCode: true, trust: 'untrusted', code: { files: ['.pi/extensions/local.ts'] } })
    const pi = plugins.find((plugin) => plugin.id === 'pi')!
    expect(pi.required).toBe('Pi runs every session.')
    expect(pi.contributions.filter((entry) => entry.kind === 'code').map((entry) => [entry.name, entry.state])).toEqual([['mcp', 'on'], ['llama.cpp', 'off']])
  })

  it('gives every tool, prompt section and tool group of the harness to one plugin', () => {
    for (const pick of [(plugin: PluginDescriptor) => (plugin.tools ?? []).map((tool) => tool.name), (plugin: PluginDescriptor) => (plugin.sections ?? []).map((section) => section.id), (plugin: PluginDescriptor) => plugin.toolGroups ?? []]) {
      const names = HARNESS_PLUGINS.flatMap(pick)
      expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([])
    }
    const declared = HARNESS_PLUGINS.flatMap((plugin) => (plugin.tools ?? []).map((tool) => tool.name))
    expect(HARNESS_TOOLS.map((tool) => tool.name).filter((name) => !declared.includes(name))).toEqual([])
  })

  it('lists nothing a folder brings when no folder is named, and what every account shares even before the first account exists', async () => {
    const { call } = setup()
    expect((await call<Plugin[]>('plugins.list')).map((plugin) => plugin.id)).not.toContain('project')
    const fresh = createHarness({ dataRoot: rootWithProject(), stateDir: mkdtempSync(join(tmpdir(), 'hs-')), secrets: memorySecretStore(), resolver: async () => [{ kind: 'skill', path: '/shared/skills/a/SKILL.md', origin: 'shared', project: false, packageRoot: null, source: null, enabled: true }] })
    open.push(fresh)
    // The shared folder is the same for every account, so it stands in until there is one.
    expect(((await methods(fresh)['plugins.list']({})) as Plugin[]).map((plugin) => plugin.source)).toContain('shared')
    // An account that was named and does not exist is not replaced by anything.
    expect(((await methods(fresh)['plugins.list']({ accountId: 'missing' })) as Plugin[]).map((plugin) => plugin.source)).not.toContain('shared')
  })

  it("trusts a folder's code only while it is the code that was shown", async () => {
    const { call, cwd } = setup()
    const before = (await call<Plugin[]>('plugins.list', { cwd })).find((plugin) => plugin.id === 'project')!
    await expect(call('plugins.trust', { cwd, hash: 'stale' })).rejects.toMatchObject({ message: expect.stringContaining('changed since it was shown') })
    const trusted = (await call<Plugin[]>('plugins.trust', { cwd, hash: before.code!.hash })).find((plugin) => plugin.id === 'project')!
    expect(trusted.trust).toBe('trusted')
    expect(trusted.contributions[0].state).toBe('on')

    writeFileSync(join(cwd, '.pi/extensions/local.ts'), 'export default function () { /* changed */ }\n')
    expect((await call<Plugin | null>('plugins.get', { cwd, pluginId: 'project' }))?.trust).toBe('untrusted')
    const again = (await call<Plugin | null>('plugins.get', { cwd, pluginId: 'project' }))!
    await call('plugins.trust', { cwd, hash: again.code!.hash })
    expect((await call<Plugin[]>('plugins.untrust', { cwd, hash: again.code!.hash })).find((plugin) => plugin.id === 'project')?.trust).toBe('untrusted')
  })
})

describe('what reaches one caller', () => {
  const launch = {
    tools: ['read', 'bash', 'start_task', 'web_search'],
    connections: 'Use mcp_list_tools.',
    sections: [{ id: 'identity', title: 'Identity', body: 'You are Ada.', budget: 500, order: 10 }],
    toolGroups: [{ group: 'Tasks', tools: ['start_task'], guidance: 'Tasks: start_task hands work to another session.', order: 40 }]
  }

  it('attributes every prompt section, tool group and tool to a plugin', async () => {
    const { call, cwd, harness } = setup()
    const { commit } = await import('../variant/store')
    commit(harness.env.root, 'a1', { 'systemprompt.md': 'You review changes.\n', 'guardrails.md': '- When writing release notes, load the `release` skill.\n', 'memory.md': '', 'tool_guidance.md': 'Prefer grep.\n', 'skills/release/SKILL.md': '---\nname: release\ndescription: writing release notes\n---\nSteps.\n' }, { kind: 'seed' })
    const result = await call<Inventory>('plugins.inventory', { cwd, context: { agentId: 'a1', projectId: 'p1' }, launch, tools: ['read', 'bash', 'start_task', 'web_search'], variant: { scope: 'a1' } })
    expect(result.unattributed).toEqual([])
    const of = (plugin: string) => result.items.filter((item) => item.pluginId === plugin).map((item) => `${item.kind}:${item.name}:${item.delivery}`)
    expect(of('app-identity')).toEqual(['instruction:Identity line:system'])
    expect(of('app-tasks')).toEqual(['instruction:Tool guidance: Tasks:system', 'tool:start_task:tool'])
    expect(of('variant')).toEqual(['instruction:Harness identity:system', 'instruction:System prompt:system', 'instruction:Guardrails:system', 'instruction:Reporting:system', 'skill:release:on-demand', 'tool:skill_load:tool'])
    expect(of('wiki')).toEqual(['instruction:Wiki:context', 'instruction:Tool guidance: Wiki:system', 'tool:wiki_search:tool', 'tool:wiki_read:tool', 'tool:wiki_list:tool'])
    expect(of('history')).toEqual(['instruction:Tool guidance: History:system', 'tool:history_search:tool', 'tool:history_read:tool', 'tool:trajectory_search:tool', 'tool:trajectory_read:tool'])
    expect(of('pi')).toEqual(['instruction:Tool guidance: Native:system', 'tool:read:tool', 'tool:bash:tool', 'instruction:Base prompt:system'])
    // The working folder's code is not trusted, so only its instruction file reaches the caller.
    expect(of('project')).toEqual(['instruction:AGENTS.md:system'])
    expect(of('package:review-kit')).toEqual(['code:guard.ts:code', 'skill:audit:on-demand'])
    expect(result.items.find((item) => item.name === 'AGENTS.md')?.chars).toBe(10)
    expect(result.systemChars).toBeGreaterThan(0)
    expect(result.contextChars).toBeGreaterThan(0)
    expect(result.plugins.map((plugin) => plugin.id)).not.toContain('home-not-there')
    expect(result.plugins.every((plugin) => result.items.some((item) => item.pluginId === plugin.id))).toBe(true)
  })

  it('reports what no plugin accounts for', async () => {
    const { call } = setup()
    const result = await call<Inventory>('plugins.inventory', {
      context: { agentId: 'a1' },
      launch: { ...launch, sections: [...launch.sections, { id: 'mystery', title: 'Mystery', body: 'Unlisted text.', budget: 500, order: 20 }], toolGroups: [...launch.toolGroups, { group: 'Secret', tools: ['hidden_tool'], guidance: 'Secret: hidden_tool.', order: 50 }], tools: [...launch.tools, 'hidden_tool'] },
      tools: [...launch.tools, 'hidden_tool']
    })
    expect(result.unattributed).toEqual([
      { kind: 'section', id: 'mystery' },
      { kind: 'toolGroup', id: 'Secret' },
      { kind: 'tool', id: 'hidden_tool' }
    ])
  })

  it("lists the pi command's own extensions for no session, so the terminal and a host match", async () => {
    const { call } = setup()
    const names = async (context: Record<string, unknown>) => (await call<Inventory>('plugins.inventory', { context, launch })).items.filter((item) => item.kind === 'code' && item.pluginId === 'pi').map((item) => item.name)
    expect(await names({ agentId: 'a1' })).toEqual([])
    expect(await names({ sessionId: 's1', actor: 'Code', surface: 'cli' })).toEqual([])
  })
})

describe('switching a plugin on and off', () => {

  it('stops a found plugin, or one item of it, from loading for the caller it was switched off for', async () => {
    const { call, harness, cwd, base } = setup()
    const agentDir = harness.accounts.context(harness.accounts.resolve(null, null)).configDir
    const guard = join(base, 'package/extensions/guard.ts')
    const audit = join(base, 'package/skills/audit/SKILL.md')
    const loaded = async (caller: { agentId?: string; projectId?: string }) => {
      const loading = await harness.plugins.loading({ cwd, agentDir, caller })
      return { guard: loading.extensionPaths.includes(guard), audit: loading.skillPaths.includes(audit) }
    }
    expect(await loaded({})).toEqual({ guard: true, audit: true })

    const off = await call<Plugin[]>('plugins.detach', { cwd, id: 'package:review-kit', scope: { projectId: 'p1' } })
    expect(off.find((plugin) => plugin.id === 'package:review-kit')!.attachment).toEqual({ global: true, on: { agentIds: [], projectIds: [] }, off: { agentIds: [], projectIds: ['p1'] } })
    expect(await loaded({ projectId: 'p1' })).toEqual({ guard: false, audit: false })
    expect(await loaded({})).toEqual({ guard: true, audit: true })
    // One item back on, inside a plugin that is off.
    await call('plugins.attach', { cwd, id: 'package:review-kit/skill/audit', scope: { projectId: 'p1' } })
    expect(await loaded({ projectId: 'p1' })).toEqual({ guard: false, audit: true })
    expect(summary(await call<Plugin[]>('plugins.list', { cwd, projectId: 'p1' })).find(([id]) => id === 'package:review-kit')![2]).toEqual(['code:guard.ts:off', 'skill:audit:on'])

    // What is switched off does not reach the caller's inventory either.
    const inventory = await call<Inventory>('plugins.inventory', { cwd, context: { projectId: 'p1', actor: 'Code' } })
    expect(inventory.items.filter((item) => item.pluginId === 'package:review-kit').map((item) => item.name)).toEqual(['audit'])
  })

  it('refuses a required part, an application part, and a file Pi reads itself, and says why', async () => {
    const { call, cwd } = setup()
    await expect(call('plugins.detach', { id: 'variant' })).rejects.toThrow('Variant cannot be switched off. Every agent runs on a variant')
    await expect(call('plugins.detach', { id: 'wiki/tool/wiki_read' })).rejects.toThrow('cannot be switched off')
    await expect(call('plugins.detach', { id: 'app-tasks' })).rejects.toThrow('switched by the application')
    await expect(call('plugins.detach', { cwd, id: 'project/instruction/AGENTS.md' })).rejects.toThrow('cannot be switched on its own')
    await expect(call('plugins.detach', { id: 'no-such-plugin' })).rejects.toThrow()
    await expect(call('plugins.attach', { id: 'package:review-kit', scope: { projectId: 'nope' } })).rejects.toThrow()
  })

  it('switches a connected app for one agent through its own scope', async () => {
    const { call, harness } = setup()
    await harness.apps.save({ id: 'c1', name: 'Docs', kind: 'local', command: 'docs-server', enabled: true, global: true })
    const id = 'connected-apps/connection/c1'
    const off = await call<Plugin[]>('plugins.detach', { id, scope: { agentId: 'a1' } })
    expect(off.flatMap((plugin) => plugin.contributions).find((entry) => entry.id === id)).toMatchObject({ state: 'on', scope: 'Everywhere', attachment: { global: true, off: { agentIds: ['a1'], projectIds: [] } } })
    expect(harness.apps.connections.forScope({ agentId: 'a1' })).toEqual([])
    expect(harness.apps.connections.forScope({ agentId: 'a2' }).map((connection) => connection.id)).toEqual(['c1'])
    await call('plugins.attach', { id, scope: { agentId: 'a1' } })
    expect(harness.apps.connections.forScope({ agentId: 'a1' }).map((connection) => connection.id)).toEqual(['c1'])
  })
})

