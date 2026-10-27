import { describe, expect, it } from 'vitest'

import { capabilitySet } from './runSnapshot'

describe('a pinned capability set', () => {
  it('reads a pre-rename tool name as the current one', () => {
    const set = capabilitySet({ version: 1, tools: ['checklist_write', 'session_name', 'todo_write'], connectors: [], contributions: [] })
    expect(set.tools).toEqual(['todo_write', 'session_name'])
  })
})
