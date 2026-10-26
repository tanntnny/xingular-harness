import { describe, expect, it, vi } from 'vitest'
import type { Harness } from '../harness'
import type { Handler } from '../server/rpc'
import type { WorldOptions, WorldPart } from '../world/world'
import type { ToolSpec } from '../tools/types'
import type { PluginDescriptor } from './types'
import { SPAWN_SUBAGENT, WAIT_SUBAGENTS } from '../sessions/subagents'
import { createBuiltinPluginRegistry, type BuiltinPluginModule, type BuiltinToolContext } from './builtinRegistry'
import { BUILTIN_PLUGIN_REGISTRY } from './builtin'

const descriptor = (id: string): PluginDescriptor => ({ id, title: id, description: `${id} feature` })
const part = (plugin: PluginDescriptor): WorldPart => ({ plugin, tools: () => [] })
const context = { options: {} as WorldOptions, setting: () => 0, browserEngine: null }

describe('built-in plugin registry', () => {
  it('keeps each command attached to its owning module and constructs only registered surfaces', () => {
    const worldPart = part(descriptor('world'))
    const handler = vi.fn(async () => ({})) as Handler
    const module: BuiltinPluginModule = {
      descriptor: descriptor('world'),
      commands: [{ name: 'inspect', description: 'Inspect the world' }],
      createWorldPart: () => worldPart,
      serverMethods: () => ({ 'world.inspect': handler })
    }
    const registry = createBuiltinPluginRegistry([module])

    expect(registry.descriptors()).toEqual([module.descriptor])
    expect(registry.commands()).toEqual([{ pluginId: 'world', prefix: 'world', name: 'inspect', description: 'Inspect the world', legacyBare: false }])
    expect(registry.command('world', 'inspect')?.pluginId).toBe('world')
    expect(registry.worldParts(context)).toEqual([worldPart])
    expect(registry.serverMethods({} as Harness)).toEqual({ 'world.inspect': handler })
  })

  it('namespaces required plugin commands while retaining their temporary bare alias', () => {
    const registry = createBuiltinPluginRegistry([{
      descriptor: { ...descriptor('required'), required: 'Always available.' },
      commands: [{ name: 'inspect', description: 'Inspect the world' }]
    }])

    expect(registry.commands()).toEqual([{ pluginId: 'required', prefix: 'required', name: 'inspect', description: 'Inspect the world', legacyBare: true }])
    expect(registry.command('required', 'inspect')?.legacyBare).toBe(true)
  })

  it('rejects duplicate plugin IDs and command names at registry construction', () => {
    expect(() => createBuiltinPluginRegistry([
      { descriptor: descriptor('one'), commands: [{ name: 'inspect', description: 'First' }] },
      { descriptor: descriptor('one') }
    ])).toThrow('Duplicate built-in plugin id: one')

    const separateOwners = createBuiltinPluginRegistry([
      { descriptor: descriptor('one'), commands: [{ name: 'inspect', description: 'First' }] },
      { descriptor: descriptor('two'), commands: [{ name: 'inspect', description: 'Second' }] }
    ])
    expect(separateOwners.commands().map(command => `${command.prefix}:${command.name}`)).toEqual(['one:inspect', 'two:inspect'])
    expect(() => createBuiltinPluginRegistry([
      { descriptor: descriptor('one'), commands: [{ name: 'inspect', description: 'First' }, { name: 'inspect', description: 'Second' }] }
    ])).toThrow('Duplicate built-in plugin command: one:inspect')
    expect(() => createBuiltinPluginRegistry([
      { descriptor: descriptor('one'), commandPrefix: 'shared', commands: [{ name: 'inspect', description: 'First' }] },
      { descriptor: descriptor('two'), commandPrefix: 'shared', commands: [{ name: 'deploy', description: 'Second' }] }
    ])).toThrow('Duplicate built-in plugin command prefix: shared')
    expect(() => createBuiltinPluginRegistry([{
      descriptor: descriptor('root'), defaultCommand: 'missing', commands: [{ name: 'inspect', description: 'Inspect' }]
    }])).toThrow('Unknown default command for built-in plugin root: missing')
  })

  it('rejects overlapping server method ownership', () => {
    const registry = createBuiltinPluginRegistry([
      { descriptor: descriptor('one'), serverMethods: () => ({ 'shared.read': vi.fn() as Handler }) },
      { descriptor: descriptor('two'), serverMethods: () => ({ 'shared.read': vi.fn() as Handler }) }
    ])

    expect(() => registry.serverMethods({} as Harness)).toThrow('Duplicate built-in server method: shared.read')
  })

  it('orders tool contributions by their registered plugin order', () => {
    const tool = (name: string) => ({ name }) as ToolSpec
    const registry = createBuiltinPluginRegistry([
      { descriptor: descriptor('late'), toolOrder: 20, tools: () => [tool('late-tool')] },
      { descriptor: descriptor('early'), toolOrder: 10, tools: () => [tool('early-tool')] }
    ])

    expect(registry.tools({} as BuiltinToolContext).map(item => item.name)).toEqual(['early-tool', 'late-tool'])
  })

  it('keeps first-class Harness pages out of plugin command metadata', () => {
    const routes = BUILTIN_PLUGIN_REGISTRY.commands().map(command => `${command.prefix}:${command.name}`)
    expect(routes).toEqual(['annotate:notes', 'annotate:annotate', 'usage:analysis', 'usage:limit'])
    expect(BUILTIN_PLUGIN_REGISTRY.defaultCommand('annotate')?.name).toBe('annotate')
    expect(BUILTIN_PLUGIN_REGISTRY.defaultCommand('usage')?.name).toBe('analysis')
    expect(BUILTIN_PLUGIN_REGISTRY.descriptors().map(plugin => plugin.id)).toEqual(expect.arrayContaining([
      'web', 'browser', 'annotations', 'history', 'subagents', 'connected-apps', 'hub', 'refinement', 'doctor', 'worktrees'
    ]))
    expect(BUILTIN_PLUGIN_REGISTRY.modules.find(module => module.descriptor.id === 'subagents')?.tools).toBeTypeOf('function')
    expect(BUILTIN_PLUGIN_REGISTRY.modules.find(module => module.descriptor.id === 'connected-apps')?.tools).toBeTypeOf('function')
    for (const id of ['history', 'subagents', 'doctor', 'worktrees', 'usage']) {
      expect(BUILTIN_PLUGIN_REGISTRY.modules.find(module => module.descriptor.id === id)?.serverMethods).toBeTypeOf('function')
    }
  })

  it('composes connected-app and subagent tools through their registered owners', () => {
    const registryTools = BUILTIN_PLUGIN_REGISTRY.tools({
      env: {} as BuiltinToolContext['env'],
      caller: {} as BuiltinToolContext['caller'],
      variantDir: null,
      run: {} as BuiltinToolContext['run'],
      runId: 'run',
      allowedTools: [SPAWN_SUBAGENT, WAIT_SUBAGENTS],
      harnessTools: false,
      subagents: {} as BuiltinToolContext['subagents'],
      sessionName: {} as ToolSpec,
      connectionTools: () => [{ name: 'mcp_list_tools' } as ToolSpec]
    })

    expect(registryTools.map(tool => tool.name)).toEqual(['mcp_list_tools', SPAWN_SUBAGENT, WAIT_SUBAGENTS])
  })
})
