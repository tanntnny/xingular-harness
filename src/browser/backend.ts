// Tool-provider adapter; the schema module stays safe for non-Node hosts.
import type { ToolResult, ToolSpec } from '../tools/types'
import { BROWSER_TOOL_NAMES, BROWSER_TOOLS, type BrowserToolName } from './contracts'

export function browserToolSpec(name: BrowserToolName): Omit<ToolSpec, 'execute'> {
  const definition = BROWSER_TOOLS.find(tool => tool.name === name)
  if (!definition) throw new Error(`Unknown browser tool: ${name}`)
  const { inputSchema, ...metadata } = definition
  return { ...metadata, parameters: Type => Type.Unsafe(inputSchema) }
}

/** A backend must enforce accessible-tab isolation, snapshot-scoped ref freshness, sensitive-field
 * refusal, fresh consequential-action approval and revalidation after the person decides. It must
 * also refuse interactions without an attended person and preserve plan-mode restrictions. If it
 * cannot implement an operation safely, `unsupported` must refuse before effects; refs are never
 * approximated with CSS selectors and there is no automatic backend switch. Providers still pass
 * these tools through the Harness capability, plan-mode and policy gates.
 */
export interface BrowserBackend {
  readonly id: string
  unsupported(name: BrowserToolName, input: Record<string, unknown>): string | null
  execute(name: BrowserToolName, input: Record<string, unknown>): Promise<string | ToolResult>
}

export function browserBackendTools(backend: BrowserBackend, names: readonly BrowserToolName[] = BROWSER_TOOL_NAMES): ToolSpec[] {
  return names.map(name => ({
    ...browserToolSpec(name),
    execute: async input => {
      const reason = backend.unsupported(name, input)
      return reason ? `${name} is unsupported by ${backend.id}: ${reason} Nothing was done.` : backend.execute(name, input)
    }
  }))
}
