import { expect, test } from 'vitest'

import { listCommands } from '../commands/list'
import { BUILTIN_PLUGIN_REGISTRY, HARNESS_PLUGINS } from './builtin'

test('the usage plugin declares both namespaced commands and a namespace root', () => {
  const routes = BUILTIN_PLUGIN_REGISTRY.commands().filter((command) => command.pluginId === 'usage')
  expect(routes.map((command) => `${command.prefix}:${command.name}`).sort()).toEqual(['usage:analysis', 'usage:limit'])
  const root = BUILTIN_PLUGIN_REGISTRY.defaultCommand('usage')
  expect(root?.name).toBe('analysis')
})

test('commands.list publishes the usage routes without running anything', () => {
  const commands = listCommands([])
  const names = commands.map((command) => command.name)
  expect(names).toContain('usage:')
  expect(names).toContain('usage:analysis')
  expect(names).toContain('usage:limit')
  const analysis = commands.find((command) => command.name === 'usage:analysis')
  expect(analysis).toMatchObject({ source: 'plugin', owner: 'usage' })
})

test('the plugin carries its settings and no model tools', () => {
  const descriptor = HARNESS_PLUGINS.find((plugin) => plugin.id === 'usage')
  expect(descriptor?.settings?.map((setting) => setting.key).sort()).toEqual(['experimentalProbes', 'refreshMinutes'])
  expect(descriptor?.tools).toBeUndefined()
  expect(descriptor?.required).toBeUndefined()
})
