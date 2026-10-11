// The memory, recall, and Wiki tools every session has.
import { dispatch, type DispatchEnv } from '../memory/dispatch'
import type { CallerContext } from '../memory/caller'
import { describeTool, WIKI_AGENT_TOOLS } from './definitions'
import type { ToolSpec } from './types'

export function memoryTools(env: DispatchEnv, context: CallerContext): ToolSpec[] {
  return WIKI_AGENT_TOOLS.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: describeTool(tool, env.productName),
    parameters: (Type) => Type.Unsafe(tool.parameters),
    execute: async (input) => {
      try {
        return dispatch(env, context, tool.call, input) || 'Nothing found.'
      } catch (error) {
        // The model sees the reason and can adjust, rather than the run failing.
        return `The Wiki could not do that: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }))
}
