import { describe, expect, it } from 'vitest'

import { CACHE_HIT_WINDOW, cacheHitLevel, recentCacheUsage, statusBarPieces, statusBarText } from './statusBar'

const cache = (inputTokens: number, cacheReadTokens: number, requests = 3, cacheWriteTokens = 40) => ({ inputTokens, cacheReadTokens, cacheWriteTokens, requests })

const state = {
  cwd: '/work/project', branch: 'main', account: 'Tanny',
  model: { name: 'Claude Sonnet 4.6' }, thinking: 'high',
  inputTokens: 1300, outputTokens: 50, cache: cache(1300, 650)
}

describe('the composer status bar', () => {
  it('joins project and branch with : and separates the remaining groups with |', () => {
    expect(statusBarText({ ...state, cache: cache(1300, 1200) })).toBe('project:main | Tanny Sonnet 4.6 high | ↑1K R92% ↓50')
  })

  it('shows the rounded cache hit rate after input tokens and uses zero when there is no input', () => {
    expect(statusBarText({ ...state, inputTokens: 3, cache: cache(3, 2) })).toContain('↑3 R67% ⚠ ↓50')
    expect(statusBarText({ ...state, inputTokens: 0, cache: cache(0, 0, 0, 0) })).toContain('↑0 R0% ↓50')
  })

  it('formats each count with K, M, B or no unit', () => {
    expect(statusBarText({ ...state, inputTokens: 999, outputTokens: 1_000, cache: cache(999, 900) })).toContain('↑999 R90% ↓1K')
    expect(statusBarText({ ...state, inputTokens: 1_999_999, outputTokens: 2_000_000_000, cache: cache(1_999_999, 1_000_000) })).toContain('↑1M R50% ⚠ ↓2B')
  })

  it('shows session totals beside the rate of recent requests', () => {
    expect(statusBarText({ ...state, inputTokens: 5_000_000, cache: cache(1_000_000, 200_000, 10) })).toContain('↑5M R20% ⚠ ↓50')
  })

  it('keeps readable fallbacks when the branch, account or model is unavailable', () => {
    expect(statusBarText({ ...state, branch: null, account: undefined, model: undefined }))
      .toBe('project:— | account unknown no model high | ↑1K R50% ⚠ ↓50')
  })

  it('keeps metadata on one sanitized line', () => {
    const text = statusBarText({ ...state, branch: 'main\nnext', account: 'Tanny\x1b]2;title\x07' })
    expect(text).not.toContain('\n')
    expect(text).not.toContain('title')
    expect(text).toContain('main next')
  })

  it('shows remote control after the tokens while it is on', () => {
    expect(statusBarText({ ...state, remoteControl: 'waiting' })).toBe('project:main | Tanny Sonnet 4.6 high | ↑1K R50% ⚠ ↓50 | rc')
    expect(statusBarText({ ...state, remoteControl: 'connected' })).toBe('project:main | Tanny Sonnet 4.6 high | ↑1K R50% ⚠ ↓50 | rc ●')
    expect(statusBarText({ ...state, remoteControl: null }).split(' | ')).toHaveLength(3)
  })

  it('marks only a flagged cache hit rate, with its level, for colour', () => {
    expect(statusBarPieces({ ...state, cache: cache(1300, 1200) }).some(piece => piece.cacheHit)).toBe(false)
    expect(statusBarPieces(state).find(piece => piece.cacheHit)).toEqual({ text: 'R50% ⚠', cacheHit: 'warning' })
    expect(statusBarPieces({ ...state, cache: cache(1300, 100) }).find(piece => piece.cacheHit))
      .toEqual({ text: 'R8% ⚠', cacheHit: 'critical' })
  })
})

describe('the cache hit level', () => {
  const window = { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 2 }

  it('is ok at 70 percent and above, warning below 70 and critical below 40', () => {
    expect(cacheHitLevel({ ...window, cacheReadTokens: 700 })).toBe('ok')
    expect(cacheHitLevel({ ...window, cacheReadTokens: 690 })).toBe('warning')
    expect(cacheHitLevel({ ...window, cacheReadTokens: 400 })).toBe('warning')
    expect(cacheHitLevel({ ...window, cacheReadTokens: 390 })).toBe('critical')
  })

  it('judges the rounded percentage the bar shows', () => {
    expect(cacheHitLevel({ ...window, cacheReadTokens: 696 })).toBe('ok')
    expect(statusBarText({ ...state, inputTokens: 1000, cache: { ...window, cacheReadTokens: 696 } })).toContain('R70% ↓50')
  })

  it('does not judge a single response, which only writes the cache', () => {
    expect(cacheHitLevel({ ...window, requests: 1, cacheWriteTokens: 500 })).toBe('ok')
  })

  it('does not judge usage with no cache reads or writes, since the provider may not report them', () => {
    expect(cacheHitLevel({ ...window, requests: 5 })).toBe('ok')
  })

  it('judges usage that writes the cache but never reads it', () => {
    expect(cacheHitLevel({ ...window, requests: 5, cacheWriteTokens: 500 })).toBe('critical')
  })

  it('is not judged without input', () => {
    expect(cacheHitLevel({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 500, requests: 5 })).toBe('ok')
  })
})

describe('recent cache usage', () => {
  const reply = (input: number, cacheRead: number, cacheWrite = 0) => ({ role: 'assistant', usage: { input, cacheRead, cacheWrite, output: 5 } })

  it('sums the last ten responses, input including cache reads', () => {
    const healthy = Array.from({ length: 30 }, () => reply(10, 990))
    const collapsed = Array.from({ length: CACHE_HIT_WINDOW }, () => reply(800, 200, 1))
    expect(recentCacheUsage([...healthy, ...collapsed])).toEqual({ inputTokens: 10_000, cacheReadTokens: 2_000, cacheWriteTokens: 10, requests: 10 })
  })

  it('skips responses without prompt tokens and messages that are not responses', () => {
    const messages = [reply(100, 900), { role: 'user', content: 'go' }, { role: 'toolResult', usage: { input: 50 } }, reply(0, 0), { role: 'assistant' }]
    expect(recentCacheUsage(messages)).toEqual({ inputTokens: 1_000, cacheReadTokens: 900, cacheWriteTokens: 0, requests: 1 })
  })

  it('uses what there is when there are fewer than ten', () => {
    expect(recentCacheUsage([reply(100, 300), reply(50, 550, 7)])).toEqual({ inputTokens: 1_000, cacheReadTokens: 850, cacheWriteTokens: 7, requests: 2 })
    expect(recentCacheUsage([])).toEqual({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 })
  })
})
