import { describe, expect, it } from 'vitest'

import { statusBarGroups, statusBarText } from './statusBar'

const state = {
  cwd: '/work/project', branch: 'main', account: 'Tanny',
  model: { name: 'Claude Sonnet 4.6' }, thinking: 'high',
  inputTokens: 1300, cacheReadTokens: 650, outputTokens: 50
}

describe('the composer status bar', () => {
  it('joins project and branch with : and separates the remaining groups with |', () => {
    expect(statusBarText(state)).toBe('project:main | Tanny Sonnet 4.6 high | ↑1K R50% ↓50')
    expect(statusBarGroups(state)).toHaveLength(3)
  })

  it('shows the rounded cache hit rate after input tokens and uses zero when there is no input', () => {
    expect(statusBarText({ ...state, inputTokens: 3, cacheReadTokens: 2 })).toContain('↑3 R67% ↓50')
    expect(statusBarText({ ...state, inputTokens: 0, cacheReadTokens: 0 })).toContain('↑0 R0% ↓50')
  })

  it('formats each count with K, M, B or no unit', () => {
    expect(statusBarText({ ...state, inputTokens: 999, outputTokens: 1_000 })).toContain('↑999 R65% ↓1K')
    expect(statusBarText({ ...state, inputTokens: 1_999_999, cacheReadTokens: 1_000_000, outputTokens: 2_000_000_000 })).toContain('↑1M R50% ↓2B')
  })

  it('keeps readable fallbacks when the branch, account or model is unavailable', () => {
    expect(statusBarText({ ...state, branch: null, account: undefined, model: undefined }))
      .toBe('project:— | account unknown no model high | ↑1K R50% ↓50')
  })

  it('keeps metadata on one sanitized line', () => {
    const text = statusBarText({ ...state, branch: 'main\nnext', account: 'Tanny\x1b]2;title\x07' })
    expect(text).not.toContain('\n')
    expect(text).not.toContain('title')
    expect(text).toContain('main next')
  })
})
