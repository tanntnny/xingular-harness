import { HarnessError, invalid } from '../core/errors'
import type { Subagents } from '../sessions/subagentService'
import { SPAWN_SUBAGENT, WAIT_SUBAGENTS, SUBAGENT_RECEIPT, MAX_SUBAGENT_TITLE_WORDS, subagentTitle, type SubagentReceipt, type SubagentResult } from '../sessions/subagents'
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
    description: 'Start a fresh child run for independent work. Delegate substantial, bounded tasks that benefit from a separate context, not simple lookups, tiny edits or tightly coupled steps. Prefer a named specialist profile; omit agent only when no profile fits. Plan mode permits only eligible read-only research profiles. Give a short title and a self-contained brief: the child has no conversation history and no more capabilities than you. The optional tools field only narrows the profile and parent intersection; in plan mode, omit it unless you need a stricter subset. Returns its run ID immediately by default so you can continue other useful work. Results arrive automatically before you finish. Use wait_subagents when you need results before proceeding, or wait: true for an inline result. Avoid overlapping write assignments. Stopping you stops your children. To resume a child that stopped before finishing (interrupted or failed), pass continue with its run ID and no title, agent or tools: it reopens that child\'s own conversation with the same profile and tools, and brief becomes an optional extra instruction.',
    planModeSafe: input => service.planSpawnRefusal(parentRunId, input) === null,
    parameters: (Type) => Type.Object({
      title: Type.Optional(Type.String({ description: `Required for a new child: a short imperative title for the roster, at most ${MAX_SUBAGENT_TITLE_WORDS} words, such as "Map the auth flow"` })),
      brief: Type.Optional(Type.String({ description: 'Required for a new child: a self-contained task: goal, relevant context or paths, non-goals, expected result, and acceptance or verification. The child cannot see this conversation. With continue, an optional extra instruction.' })),
      continue: Type.Optional(Type.String({ description: 'The run ID of one of your subagents that stopped before finishing, to continue it from where it stopped instead of starting a fresh child' })),
      agent: Type.Optional(Type.String({ description: 'The name of a specialist profile from your Subagents list; omit only when no listed profile fits (omitting starts an unprofiled copy)' })),
      tools: Type.Optional(Type.Array(Type.String({ description: 'Only request a stricter subset of the profile and parent tools. In plan mode, omit this field to inherit the safe available research intersection.' }))),
      wait: Type.Optional(Type.Boolean({ description: 'Wait for the child and return its result; default false' }))
    }),
    execute: execute(async (input) => {
      const resume = input.continue === undefined ? undefined : input.continue as string
      const title = resume === undefined ? subagentTitle(input.title) : undefined
      if (resume === undefined && !title) throw invalid(`Give the subagent a title of at most ${MAX_SUBAGENT_TITLE_WORDS} words, with no control characters.`)
      const child = await service.spawn({ parentRunId, brief: input.brief as string, title, agent: input.agent as string | undefined, tools: input.tools as string[] | undefined, wait: input.wait as boolean | undefined, ...(resume === undefined ? {} : { continue: resume }) })
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
