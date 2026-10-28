import { describe, expect, it } from 'vitest'

import { DEFAULT_SUBAGENT_CHILDREN, MAX_SUBAGENT_CHILDREN, subagentProfileKey, subagentProfileLimit, subagentQuota } from './subagents'

describe('subagent quota', () => {
  it('defaults to four children with per-profile limits', () => {
    expect(DEFAULT_SUBAGENT_CHILDREN).toBe(4)
    expect(subagentQuota(undefined)).toEqual({ children: 4, profiles: { worker: 2, explorer: 3 }, other: 1, unprofiled: 1 })
  })

  it('merges a profile override over the defaults', () => {
    expect(subagentQuota({ maxByProfile: { worker: 1, reviewer: 2 } }).profiles).toEqual({ worker: 1, explorer: 3, reviewer: 2 })
  })

  it('clamps values and ignores names or numbers it cannot use', () => {
    const quota = subagentQuota({
      maxChildren: -3,
      maxOther: 1.9,
      maxUnprofiled: Number.NaN,
      maxByProfile: { '': 2, worker: Infinity, 'bad\nname': 1, explorer: 2 }
    })
    expect(quota).toEqual({ children: 0, profiles: { worker: 2, explorer: 2 }, other: 1, unprofiled: 1 })
  })

  it('clamps the largest budget', () => {
    expect(subagentQuota({ maxChildren: 10_000 }).children).toBe(MAX_SUBAGENT_CHILDREN)
  })

  it('maps a missing profile to the unprofiled bucket and reads its limit', () => {
    expect(subagentProfileKey(null)).toBe('*')
    expect(subagentProfileKey('  ')).toBe('*')
    expect(subagentProfileKey(' worker ')).toBe('worker')
    const quota = subagentQuota(undefined)
    expect(subagentProfileLimit(quota, '*')).toBe(1)
    expect(subagentProfileLimit(quota, 'worker')).toBe(2)
    expect(subagentProfileLimit(quota, 'reviewer')).toBe(1)
  })
})
