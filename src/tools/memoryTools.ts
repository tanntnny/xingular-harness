// The memory, recall, and Wiki tools every session has.
import { dispatch, type DispatchEnv } from '../memory/dispatch'
import type { CallerContext } from '../memory/caller'
import { describeTool, WIKI_AGENT_TOOLS } from './definitions'
import type { ToolSpec } from './types'

export function memoryTools(env: DispatchEnv, context: CallerContext, contributions?: readonly string[]): ToolSpec[] {
  return WIKI_AGENT_TOOLS.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: context.vaultAccess && tool.name === 'wiki_propose' ? `Submit a durable page, fact, block, skill, rule or prompt proposal for curator review. Nothing is applied immediately. Quote original evidence. Use kind block with a full block id for ${context.vaultAccess === 'propose' ? 'any memory block change, including your own persona and notes' : 'memory beyond your own persona/notes'}.` : describeTool(tool, env.productName),
    parameters: (Type) => Type.Unsafe(tool.parameters),
    execute: async (input) => {
      try {
        return dispatch(env, context, tool.call, input, contributions) || 'Nothing found.'
      } catch (error) {
        // The model sees the reason and can adjust, rather than the run failing.
        return `The Wiki could not do that: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }))
}
