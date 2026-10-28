import { describe, expect, it, vi } from 'vitest'

import type { Subagents } from '../sessions/subagentService'
import { briefTitle, subagentQuota, subagentTitle } from '../sessions/subagents'
import { subagentTools } from './spawnSubagent'

const service = (overrides: Record<string, unknown> = {}) => ({ spawn: vi.fn(), quota: () => subagentQuota(undefined), ...overrides }) as unknown as Subagents

describe('spawn_subagent guidance', () => {
  it('sets delegation boundaries and asks for a self-contained brief', () => {
    const tool = subagentTools(service(), 'parent').find((item) => item.name === 'spawn_subagent')!
    expect(tool.description).toContain('not simple lookups, tiny edits or tightly coupled steps')
    expect(tool.description).toContain('Plan mode permits only eligible read-only research profiles')
    expect(tool.description).toContain('Avoid overlapping write assignments')
    expect(tool.description).toContain('This run allows at most 4 children: 2 worker, 3 explorer, 1 of any other profile and 1 unprofiled')
  })
})

describe('spawn_subagent title (PROP-0030)', () => {
  it('requires a title of at most six words before it starts a child', async () => {
    const spawn = vi.fn(async () => ({ runId: 'child', nativeSessionId: null }))
    const tool = subagentTools(service({ spawn }), 'parent').find((item) => item.name === 'spawn_subagent')!
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
