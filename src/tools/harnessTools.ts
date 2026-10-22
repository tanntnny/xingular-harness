// The History, Wiki and skill tools a session has.
import type { CallerContext } from '../core/caller'
import { describeTool, HARNESS_TOOLS } from './definitions'
import { dispatch, type DispatchEnv } from './dispatch'
import type { ToolSpec } from './types'

export function harnessTools(env: DispatchEnv, context: CallerContext, options: { variantDir?: string | null } = {}): ToolSpec[] {
  return HARNESS_TOOLS.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: describeTool(tool, env.productName),
    parameters: (Type) => Type.Unsafe(tool.parameters),
    readOnly: tool.name !== 'wiki_write',
    execute: async (input) => {
      try {
        return dispatch(env, context, tool.call, input, { variantDir: options.variantDir }) || 'Nothing found.'
      } catch (error) {
        // The model sees the reason and can adjust, rather than the run failing.
        return `That did not work: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }))
}
