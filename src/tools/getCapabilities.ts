// Discovery reports this run's real loadout. It never resolves another caller or changes a grant.
import type { CapabilitySet } from '../capabilities/types'
import type { ToolSpec } from './types'

export const GET_CAPABILITIES = 'get_capabilities'
export const CAPABILITY_DISCOVERY = {
  name: GET_CAPABILITIES,
  label: 'Inspect current capabilities',
  description: 'List the tools callable in this run, or inspect one tool and its input schema. Availability is not permission: calls still follow the gate. Disabled, unavailable and unregistered tools are not advertised as callable.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: { tool: { type: 'string', minLength: 1, maxLength: 200, description: 'An exact tool name to inspect. Omit to list callable tools.' } }
  }
} as const

export interface RegisteredCapabilityTool {
  name: string
  description?: string
  parameters?: unknown
}

export function describeCapabilities(input: {
  capabilities: CapabilitySet
  active: readonly string[]
  registered: readonly RegisteredCapabilityTool[]
}, name?: string): Record<string, unknown> {
  const allowed = new Set(input.capabilities.tools)
  const active = new Set(input.active)
  const tools = input.registered.filter(tool => allowed.has(tool.name) && active.has(tool.name))
  if (name) {
    const tool = tools.find(tool => tool.name === name)
    return tool
      ? { tool: { name: tool.name, description: tool.description ?? '', ...(tool.parameters !== undefined ? { inputSchema: tool.parameters } : {}), state: 'callable', permission: 'checked per call' } }
      : { tool: { name, state: 'unavailable', reason: 'This tool is not callable in the current run.' } }
  }
  return {
    tools: tools.map(tool => ({ name: tool.name, description: tool.description ?? '', state: 'callable' })),
    connectors: [...input.capabilities.connectors],
    permission: 'Availability does not grant permission. Every call still passes the gate.'
  }
}

export function getCapabilitiesTool(snapshot: () => Parameters<typeof describeCapabilities>[0]): ToolSpec {
  return {
    ...CAPABILITY_DISCOVERY,
    readOnly: true,
    parameters: Type => Type.Unsafe(CAPABILITY_DISCOVERY.parameters),
    execute: async input => JSON.stringify(describeCapabilities(snapshot(), typeof input.tool === 'string' ? input.tool : undefined))
  }
}
