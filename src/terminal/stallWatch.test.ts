import { describe, expect, it } from 'vitest'

import { REPLY_STALL_MS, TOOL_STALL_MS, replyStalled } from './stallWatch'

const now = 1_000_000_000

describe('terminal reply stall watch', () => {
  it('waits out the reply window before calling silence a stall', () => {
    expect(replyStalled({ now, progressAt: now - REPLY_STALL_MS + 1, runningTools: [] })).toBe(false)
    expect(replyStalled({ now, progressAt: now - REPLY_STALL_MS, runningTools: [] })).toBe(true)
  })

  it('gives a running tool the longer window, counted from the oldest one', () => {
    expect(replyStalled({ now, progressAt: now - REPLY_STALL_MS * 2, runningTools: [now - TOOL_STALL_MS + 1] })).toBe(false)
    expect(replyStalled({ now, progressAt: 0, runningTools: [now - TOOL_STALL_MS, now - 1_000] })).toBe(true)
  })

  it('says nothing when the clock is unusable', () => {
    expect(replyStalled({ now: Number.NaN, progressAt: 0, runningTools: [] })).toBe(false)
  })
})
