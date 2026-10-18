import { initTheme, Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'

import { displayProjectName, renderStatusBand, type BandState } from './status'
import { createHarnessTheme } from './theme'

initTheme('dark', false)
const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const state: BandState = {
  cwd: '/work/project', model: { name: 'Claude Sonnet 4.6', reasoning: true, contextWindow: 200_000 },
  thinkingLevel: 'high', branch: 'main', account: 'Tanny', inputTokens: 1300, outputTokens: 50,
  tokensPerSecond: 30
}

describe('composer status band', () => {
  it('renders the four text groups in order with distinct colors', () => {
    const line = renderStatusBand(state, 120, theme)
    expect(stripTerminalSequences(line)).toBe('project | main | Tanny · Sonnet 4.6 · high | 30 tok/s in 1,300 out 50')
    for (const color of ['38;2;232;236;244', '38;2;0;255;136', '38;2;0;180;255', '38;2;212;192;144']) {
      expect(line).toContain(color)
    }
    expect(visibleWidth(line)).toBe(stripTerminalSequences(line).length)
  })

  it('uses the last path component and a readable root fallback', () => {
    expect(displayProjectName('/work/a/long-project/')).toBe('long-project')
    expect(displayProjectName('/')).toBe('/')
  })

  it('shows text fallbacks when branch, account, model, and rate are unavailable', () => {
    const line = renderStatusBand({ ...state, branch: null, account: undefined, model: undefined, tokensPerSecond: null }, 120, theme)
    expect(stripTerminalSequences(line)).toBe('project | — | account unknown · no-model · high | — tok/s in 1,300 out 50')
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
})
