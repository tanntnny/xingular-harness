import type { Harness } from '../harness'
import type { Handler } from '../server/rpc'
import type { SubagentInput, SubagentSelection } from './subagents'

export function subagentServerMethods(harness: Harness): Record<string, Handler> {
  return {
    'subagents.spawn': (params) => harness.subagents.spawn(params as SubagentInput),
    'subagents.wait': (params) => harness.subagents.wait(params as SubagentSelection),
    'subagents.results': (params) => harness.subagents.results(params as SubagentSelection)
  }
}
