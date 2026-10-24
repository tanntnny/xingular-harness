import { describe, expect, it, vi } from 'vitest'

import type { Subagents } from '../sessions/subagentService'
import { briefTitle, subagentTitle } from '../sessions/subagents'
import { subagentTools } from './spawnSubagent'

describe('spawn_subagent title (PROP-0030)', () => {
  it('requires a title of at most six words before it starts a child', async () => {
    const spawn = vi.fn(async () => ({ runId: 'child', nativeSessionId: null }))
    const tool = subagentTools({ spawn } as unknown as Subagents, 'parent').find((item) => item.name === 'spawn_subagent')!
    expect(await tool.execute({ brief: 'Find the bug' })).toMatch(/title of at most 6 words/)
    expect(await tool.execute({ title: 'one two three four five six seven', brief: 'Find the bug' })).toMatch(/title of at most 6 words/)
    expect(spawn).not.toHaveBeenCalled()
    await tool.execute({ title: '  Map the auth flow ', brief: 'Find the login route' })
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ parentRunId: 'parent', title: 'Map the auth flow', brief: 'Find the login route' }))
  })

  it('cleans a title and derives a short one from a brief', () => {
    expect(subagentTitle('  Map   the\tauth flow ')).toBe('Map the auth flow')
    expect(subagentTitle('bad\u001b[31m title')).toBeUndefined()
    expect(briefTitle('\n  \nFirst  line\nsecond')).toBe('First line')
    expect(briefTitle('x'.repeat(100))).toHaveLength(60)
  })
})
