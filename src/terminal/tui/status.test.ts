import { initTheme, Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'

import { displayProjectName, formatContextReading, formatTokenCount, renderStatusBand, type BandState } from './status'
import { createHarnessTheme } from './theme'

initTheme('dark', false)
const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const state: BandState = {
  cwd: '/work/project', model: { name: 'Claude Sonnet 4.6', reasoning: true, contextWindow: 200_000 },
  thinkingLevel: 'high', branch: 'main', account: 'Tanny', inputTokens: 1300, outputTokens: 50
}

describe('composer status band', () => {
  it('renders the four text groups in order with distinct colors', () => {
    const line = renderStatusBand(state, 120, theme)
    expect(stripTerminalSequences(line)).toBe('project | main | Tanny · Sonnet 4.6 · high | ↑ 1K ↓ 50')
    for (const color of ['38;2;232;236;244', '38;2;0;255;136', '38;2;0;180;255', '38;2;212;192;144']) {
      expect(line).toContain(color)
    }
    expect(visibleWidth(line)).toBe(stripTerminalSequences(line).length)
  })

  it('formats token counts with floor-rounded K, M and B suffixes', () => {
    for (const [value, expected] of [
      [999.9, '999'],
      [1_000, '1K'],
      [1_999, '1K'],
      [999_999, '999K'],
      [1_000_000, '1M'],
      [1_999_999, '1M'],
      [999_999_999, '999M'],
      [1_000_000_000, '1B'],
      [1_999_999_999, '1B'],
      [-10, '0'],
      [Number.NaN, '0']
    ] as const) {
      expect(formatTokenCount(value)).toBe(expected)
    }
  })

  it('uses the last path component and a readable root fallback', () => {
    expect(displayProjectName('/work/a/long-project/')).toBe('long-project')
    expect(displayProjectName('/')).toBe('/')
  })

  it('shows text fallbacks when branch, account and model are unavailable', () => {
    const line = renderStatusBand({ ...state, branch: null, account: undefined, model: undefined }, 120, theme)
    expect(stripTerminalSequences(line)).toBe('project | — | account unknown · no-model · high | ↑ 1K ↓ 50')
  })

  it('stays within narrow terminal widths and sanitizes metadata', () => {
    for (let width = 1; width <= 180; width++) {
      const line = renderStatusBand({ ...state,
        cwd: '/work/日本語/long-project-name',
        branch: '\x1b]2;malicious title\x07main\nother',
        model: { ...state.model!, name: '非常に長い名前'.repeat(20) }
      }, width, theme)
      expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width)
      expect(stripTerminalSequences(line)).not.toContain('malicious title')
      expect(stripTerminalSequences(line)).not.toContain('\n')
    }
  })

  it('reads the context window as a share of it, and says when it is unknown', () => {
    expect(formatContextReading({ model: { name: 'x', reasoning: true, contextWindow: 200_000 }, contextPercent: 18.34 })).toBe('18.3%/200K')
    expect(formatContextReading({ model: { name: 'x', reasoning: true, contextWindow: 200_000 }, contextPercent: null })).toBe('?/200K')
    expect(formatContextReading({ contextPercent: 45.3 })).toBe('45.3%/?')
    expect(formatContextReading({ model: { name: 'x', reasoning: true, contextWindow: 1_000_000 }, contextPercent: 96.2, autoCompact: true })).toBe('96.2%/1M (auto)')
  })

  it('adds the reading to the band only when the session knows it', () => {
    expect(stripTerminalSequences(renderStatusBand(state, 120, theme))).not.toContain('%')
    const line = renderStatusBand({ ...state, contextPercent: 18.34, autoCompact: true }, 120, theme)
    expect(stripTerminalSequences(line)).toBe('project | main | Tanny · Sonnet 4.6 · high | ↑ 1K ↓ 50 | 18.3%/200K (auto)')
    expect(line).toContain('38;2;156;163;176')
  })
})
