import { describe, expect, it } from 'vitest'

import { planModeTools } from './planMode'

describe('plan mode tools', () => {
  it('keeps read-only inspection, sandboxed Bash and conditional research delegation, and withdraws changes', () => {
    const normal = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'ask_user', 'ask_user_question', 'wiki_search', 'memory_append', 'spawn_subagent', 'wait_subagents', 'app_tool', 'history_read']
    expect(planModeTools(normal)).toEqual(['read', 'bash', 'grep', 'find', 'ls', 'ask_user', 'ask_user_question', 'wiki_search', 'spawn_subagent', 'wait_subagents', 'history_read'])
    expect(planModeTools(['read', 'spawn_subagent'])).toEqual(['read', 'spawn_subagent'])
    expect(planModeTools(['read', 'write'])).toEqual(['read'])
  })
})
