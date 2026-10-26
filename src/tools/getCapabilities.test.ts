import { expect, test } from 'vitest'
import { describeCapabilities, getCapabilitiesTool } from './getCapabilities'

const snapshot = {
  capabilities: { version: 1 as const, tools: ['read', 'get_capabilities'], connectors: ['docs'], contributions: [] },
  active: ['read', 'get_capabilities', 'ask_user'],
  registered: [
    { name: 'read', description: 'Read a file', parameters: { type: 'object', required: ['path'] } },
    { name: 'get_capabilities' },
    { name: 'ask_user' },
    { name: 'wiki_write' }
  ]
}

test('discovery intersects actual active registrations with the frozen capability set', () => {
  expect(describeCapabilities(snapshot)).toMatchObject({ tools: [{ name: 'read' }, { name: 'get_capabilities' }], connectors: ['docs'] })
  expect(describeCapabilities(snapshot, 'read')).toMatchObject({ tool: { name: 'read', state: 'callable', inputSchema: { type: 'object', required: ['path'] } } })
  expect(describeCapabilities(snapshot, 'ask_user')).toMatchObject({ tool: { state: 'unavailable' } })
  expect(describeCapabilities(snapshot, 'wiki_write')).toMatchObject({ tool: { state: 'unavailable' } })
})

test('discovery neither leaks schemas of inactive tools nor grants permission', async () => {
  const tool = getCapabilitiesTool(() => ({ ...snapshot, active: [] }))
  expect(tool.readOnly).toBe(true)
  expect(JSON.parse(await tool.execute({ tool: 'read', agentId: 'other' }) as string)).toEqual({ tool: { name: 'read', state: 'unavailable', reason: 'This tool is not callable in the current run.' } })
  expect(describeCapabilities(snapshot)).toHaveProperty('permission', expect.stringContaining('gate'))
})
