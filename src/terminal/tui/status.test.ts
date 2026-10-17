import { initTheme, Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'

import { contextGauge, displayPath, renderStatusBand, type BandState } from './status'
import { createHarnessTheme } from './theme'

initTheme('dark', false)
const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const state: BandState = {
  cwd: '/work/project', model: { name: 'Claude Sonnet 4.6', reasoning: true, contextWindow: 200_000 },
  thinkingLevel: 'high', branch: 'main', contextPercent: 25, contextWindow: 200_000,
  costUsd: 0.15, subscription: false, running: false, elapsedMs: 0
}

describe('Oh My Pi status band', () => {
  it('renders the actual model, effort, branch, cost, and embedded context gauge', () => {
    const line = renderStatusBand(state, 120, theme)
    const plain = stripTerminalSequences(line)
    expect(plain).toContain('π > ◒ Sonnet 4.6 > 📁 /work/project > ⑂ main > $0.15 ▶')
    expect(plain).toContain('25%')
    expect(plain).toMatch(/200K─$/)
    expect(visibleWidth(line)).toBe(120)
    expect(line).toContain('48;2;15;18;22')
    expect(line).toContain('38;2;0;180;255')
  })

  it('stays within every narrow and wide terminal with wide, colored, and untrusted metadata', () => {
    for (let width = 1; width <= 180; width++) {
      const line = renderStatusBand({ ...state,
        cwd: '/work/日本語/long-project-name/with-many-parts',
        branch: '\x1b]2;malicious title\x07main\nother',
        model: { ...state.model!, name: '非常に長い名前'.repeat(20) }
      }, width, theme)
      expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width)
      expect(line).not.toContain('malicious title')
      expect(line).not.toContain('\n')
    }
  })

  it('never invents model, quota, usage, or git data while startup context is unknown', () => {
    const plain = stripTerminalSequences(renderStatusBand({ ...state,
      model: undefined, branch: null, contextWindow: 0, contextPercent: null, costUsd: 0
    }, 80, theme))
    expect(plain).toContain('⬢ no-model')
    expect(plain).not.toMatch(/0%|200K|main|\$|quota|plan|collab/i)
  })

  it('clamps gauge values and omits an unknown percentage while retaining the window', () => {
    for (const percent of [null, -20, 0, 50, 100, 120, NaN]) {
      for (const width of [0, 1, 5, 16, 60]) {
        const gauge = contextGauge(width, percent, 200_000, theme)
        expect(visibleWidth(gauge)).toBe(width)
        expect(stripTerminalSequences(gauge)).not.toContain('NaN')
      }
    }
    expect(stripTerminalSequences(contextGauge(20, null, 200_000, theme))).not.toContain('%')
  })

  it('keeps sibling directories outside home and shows existing subscription and overflow states', () => {
    expect(displayPath('/home/test/project', '/home/test')).toBe('~/project')
    expect(displayPath('/home/test-other/project', '/home/test')).toBe('/home/test-other/project')
    const line = stripTerminalSequences(renderStatusBand({ ...state,
      subscription: true, costUsd: 0, running: true, elapsedMs: 65_000, hiddenAbove: 4
    }, 160, theme))
    expect(line).toContain('1m 5s')
    expect(line).toContain('$0.00 (sub)')
    expect(line).toContain('↑ 4 more')
  })
})
