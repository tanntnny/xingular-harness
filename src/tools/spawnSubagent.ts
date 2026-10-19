import { HarnessError, invalid } from '../core/errors'
import type { Subagents } from '../sessions/subagentService'
import { SPAWN_SUBAGENT, WAIT_SUBAGENTS, SUBAGENT_RECEIPT, type SubagentReceipt, type SubagentResult } from '../sessions/subagents'
import type { ToolResult, ToolSpec } from './types'

export { SPAWN_SUBAGENT, SUBAGENT_RELATION, DEFAULT_SUBAGENT_DEPTH, MAX_SUBAGENT_DEPTH, subagentDepth, subagentReport, type SubagentOptions } from '../sessions/subagents'

function reported(parentRunId: string, results: SubagentResult[], spawned?: string[]): ToolResult {
  const included: SubagentResult[] = []
  let length = 0
  for (const result of results) {
    if (length + result.text.length > 24_000 && included.length) break
    included.push(result)
    length += result.text.length + 300
  }
  const receipt: SubagentReceipt = { version: 1, ownerRunId: parentRunId, ...(spawned ? { spawned } : {}), delivered: included.map((result) => result.runId) }
  return { text: JSON.stringify({ results: included, ...(results.length > included.length ? { remaining: results.slice(included.length).map((result) => result.runId) } : {}) }), details: { [SUBAGENT_RECEIPT]: receipt } }
}

export function subagentTools(service: Subagents, parentRunId: string): ToolSpec[] {
  const execute = (fn: (input: Record<string, unknown>) => Promise<ToolResult>): ToolSpec['execute'] => async (input) => {
    try { return await fn(input) } catch (error) {
      if (error instanceof HarnessError) return error.message
      throw error
    }
  }
  return [{
    name: SPAWN_SUBAGENT,
    label: 'Start a subagent',
    description: 'Start a fresh child run for independent work: yourself, or one of your subagents when you name it in agent. Give a complete brief: the child has no conversation history and no more capabilities than you. Returns its run ID immediately by default so you can continue working. Results arrive automatically before you finish. Use wait_subagents to join selected children, or wait: true for an inline result. Stopping you stops your children.',
    parameters: (Type) => Type.Object({ brief: Type.String(), agent: Type.Optional(Type.String({ description: 'The name of one of your subagents; omit for a copy of yourself' })), tools: Type.Optional(Type.Array(Type.String())), wait: Type.Optional(Type.Boolean({ description: 'Wait for the child and return its result; default false' })) }),
    execute: execute(async (input) => {
      const child = await service.spawn({ parentRunId, brief: input.brief as string, agent: input.agent as string | undefined, tools: input.tools as string[] | undefined, wait: input.wait as boolean | undefined })
      if (input.wait === true) return reported(parentRunId, service.results({ parentRunId, runIds: [child.runId] }), [child.runId])
      return { text: JSON.stringify(child), details: { [SUBAGENT_RECEIPT]: { version: 1, ownerRunId: parentRunId, spawned: [child.runId] } satisfies SubagentReceipt } }
    })
  }, {
    name: WAIT_SUBAGENTS,
    label: 'Wait for subagents',
    description: 'Wait for all selected direct subagents to settle and return their results, including failures. Omit runIds to select your current children. Do useful independent work before waiting; results also arrive automatically before your final reply.',
    parameters: (Type) => Type.Object({ runIds: Type.Optional(Type.Array(Type.String())) }),
    execute: execute(async (input) => {
      if (input.runIds !== undefined && !Array.isArray(input.runIds)) throw invalid('runIds must be an array of child run IDs.')
      return reported(parentRunId, await service.wait({ parentRunId, runIds: input.runIds as string[] | undefined }))
    })
  }]
}
