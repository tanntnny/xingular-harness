import { describe, expect, it } from 'vitest'

import { TRANSIENT_RETRY, withTransientRetry } from './retryPolicy'

function manager(global: Record<string, unknown> = {}, project: Record<string, unknown> = {}) {
  const applied: Record<string, unknown>[] = []
  return { applied, getGlobalSettings: () => ({ retry: global }), getProjectSettings: () => ({ retry: project }), applyOverrides: (overrides: Record<string, unknown>) => { applied.push(overrides) } }
}

describe('the transient retry budget', () => {
  it('rides out a few minutes of network trouble instead of Pi\'s fourteen seconds', () => {
    const delays = Array.from({ length: TRANSIENT_RETRY.maxRetries }, (_, index) => Math.min(TRANSIENT_RETRY.baseDelayMs * 2 ** index, TRANSIENT_RETRY.maxAgentDelayMs))
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(242_000)
    const made = manager()
    withTransientRetry(made)
    expect(made.applied).toEqual([{ retry: TRANSIENT_RETRY }])
  })

  it('leaves anything the person set in their own settings alone', () => {
    const made = manager({ maxRetries: 1 }, { enabled: false })
    withTransientRetry(made)
    expect(made.applied[0]).toEqual({ retry: { ...TRANSIENT_RETRY, maxRetries: 1, enabled: false } })
  })
})
