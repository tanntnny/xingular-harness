import { describe, expect, it } from 'vitest'

import { COMMAND_TIMEOUT_CEILING_SECONDS, COMMAND_TIMEOUT_MAX_SECONDS, DEFAULT_COMMAND_TIMEOUT_SECONDS, resolveCommandTimeout, withCommandBudget } from './commandBudget'

describe('command budget', () => {
  it('gives an ordinary command the default and honours a smaller timeout', () => {
    expect(resolveCommandTimeout(undefined, undefined)).toEqual({ ok: true, timeout: DEFAULT_COMMAND_TIMEOUT_SECONDS })
    expect(resolveCommandTimeout(30, undefined)).toEqual({ ok: true, timeout: 30 })
    expect(resolveCommandTimeout(300, undefined)).toEqual({ ok: true, timeout: COMMAND_TIMEOUT_CEILING_SECONDS })
  })

  it('needs a reason above the ceiling and refuses more than the maximum', () => {
    expect(resolveCommandTimeout(600, undefined)).toMatchObject({ ok: false })
    expect(resolveCommandTimeout(600, 'the release build takes ten minutes')).toEqual({ ok: true, timeout: 600 })
    expect(resolveCommandTimeout(COMMAND_TIMEOUT_MAX_SECONDS + 1, 'because')).toMatchObject({ ok: false })
  })

  it('stops a command at its budget and reaches the live shell', async () => {
    let aborted = false
    const result = await withCommandBudget(() => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 5_000)), () => {
      aborted = true
    }, 0.01).catch((error: Error) => error.message)
    expect(aborted).toBe(true)
    expect(result).toContain('stopped after 0.01 seconds')
    expect(result).toContain('Narrow it')
  })

  it('returns what a command produced when it finishes in time', async () => {
    await expect(withCommandBudget(async () => 'done', () => undefined, 5)).resolves.toBe('done')
  })
})
