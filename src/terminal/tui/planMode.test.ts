import { describe, expect, it } from 'vitest'

import { planModeTools } from './planMode'

describe('plan mode tools', () => {
  it('keeps read-only inspection, questions and recall, and withdraws changes, commands and delegation', () => {
    const normal = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'ask_user', 'ask_user_question', 'wiki_search', 'memory_append', 'spawn_subagent', 'app_tool', 'history_read']
    expect(planModeTools(normal)).toEqual(['read', 'grep', 'find', 'ls', 'ask_user', 'ask_user_question', 'wiki_search', 'history_read'])
  })
})
