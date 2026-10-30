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

  it('reads a timeout that only fits as milliseconds as milliseconds', () => {
    // GPT 6 Luna sends timeout: 120000; refusing it refused every command the model ran.
    expect(resolveCommandTimeout(120_000, undefined)).toEqual({ ok: true, timeout: 120 })
    expect(resolveCommandTimeout(1_500, undefined)).toEqual({ ok: true, timeout: 2 })
    // Converted values keep the ceiling and the maximum.
    expect(resolveCommandTimeout(600_000, undefined)).toMatchObject({ ok: false })
    expect(resolveCommandTimeout(600_000, 'the release build takes ten minutes')).toEqual({ ok: true, timeout: 600 })
    expect(resolveCommandTimeout(2_000_000, 'because')).toEqual({ ok: false, message: 'timeout is in seconds, and a command may run for at most 900 seconds. Split it into smaller commands.' })
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
