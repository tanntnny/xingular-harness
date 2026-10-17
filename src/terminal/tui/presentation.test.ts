import type { Theme } from '@earendil-works/pi-coding-agent'
import { colorToHex, stripTerminalSequences, visibleWidth, type TerminalColorMode } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'

import { createHarnessLightTheme, createHarnessTheme } from './theme'
import { gradientLogo, HarnessWelcome, PI_LOGO } from './welcome'

function titanium(mode: TerminalColorMode = 'truecolor'): Theme {
  return createHarnessTheme({ getColorMode: () => mode } as Theme)
}

describe('the Harness titanium presentation', () => {
  it('uses the upstream titanium foreground and background colors with complete Pi fallbacks', () => {
    const theme = titanium()
    expect(theme.name).toBe('harness-titanium')
    expect(theme.appearance).toBe('dark')
    const expected = {
      accent: '#00b4ff', border: '#2a3038', success: '#00ff88', error: '#ff4757',
      customMessageLabel: '#d4c090', userMessageBg: '#0f1216', toolErrorBg: '#1a0f10',
      thinkingMax: '#d4c090', scrollbarTrack: '#2a3038', scrollbarThumb: '#9ca3b0',
      searchMatchBg: '#0082b3', searchMatchText: '#e8ecf4'
    } as const
    for (const [token, color] of Object.entries(expected)) {
      expect(colorToHex(theme.colors[token as keyof typeof expected]), token).toBe(color)
    }
    expect(Object.keys(theme.colors)).toHaveLength(56)
    expect(theme.getFgAnsi('text')).toBe('\x1b[39m')
    expect(theme.getBgAnsi('userMessageBg')).toBe('\x1b[48;2;15;18;22m')
  })

  it('offers the shipped light palette with complete native component fallbacks', () => {
    const theme = createHarnessLightTheme(titanium())
    expect(theme.name).toBe('light')
    expect(theme.appearance).toBe('light')
    expect(Object.keys(theme.colors)).toHaveLength(56)
    expect(colorToHex(theme.colors.accent)).toBe('#5a8080')
    expect(colorToHex(theme.colors.selectedBg)).toBe('#d0d0e0')
    expect(colorToHex(theme.colors.toolSuccessBg)).toBe('#e8f0e8')
  })

  it('keeps the current terminal color mode and uses the exact upstream logo ramps', () => {
    const truecolor = gradientLogo(PI_LOGO, 'truecolor')
    expect(truecolor[0]).toMatch(/^\x1b\[38;2;248;79;204m█/)
    expect(truecolor[0]).toContain('\x1b[38;2;147;98;244m█\x1b[0m')
    expect(truecolor.map(stripTerminalSequences)).toEqual(PI_LOGO)
    const theme = titanium('256color')
    expect(theme.getColorMode()).toBe('256color')
    const indexed = gradientLogo(PI_LOGO, theme.getColorMode())
    expect(indexed[0]).toMatch(/^\x1b\[38;5;206m█/)
    expect(indexed[0]).toContain('\x1b[38;5;99m█\x1b[0m')
    expect(indexed.join('')).not.toContain('[38;2;')
  })

  it('keeps every rendered row within the terminal across narrow widths and Unicode product names', () => {
    for (const name of ['Xingular Harness', 'Harness 知識 🧠', 'A'.repeat(120)]) {
      const welcome = new HarnessWelcome(titanium(), name)
      for (let width = 0; width <= 160; width++) {
        const lines = welcome.render(width)
        for (const line of lines) expect(visibleWidth(line), `width ${width}, ${name}`).toBeLessThanOrEqual(width)
        if (width < 14) expect(lines).toEqual([])
      }
    }
  })

  it('shows a centered five-row logo alone in narrow terminals and centers the full lockup when it fits', () => {
    const welcome = new HarnessWelcome(titanium(), 'Xingular Harness', '0.1.6')
    const narrow = welcome.render(30).map(stripTerminalSequences)
    expect(narrow).toEqual(PI_LOGO.map((line) => ' '.repeat(9) + line))
    const wide = welcome.render(100).map(stripTerminalSequences)
    expect(wide[1]).toContain('Xingular Harness')
    expect(wide[4]).toContain('v0.1.6')
    expect(wide[0].indexOf('█')).toBe(34)
    expect(wide.slice(6).join(' ')).toContain('/accounts')
    expect(wide.slice(6).join(' ')).toContain('/plugins')
    expect(wide.slice(6).join(' ')).toContain('/hub')
    expect(wide.join('')).not.toContain('omp')
    expect(welcome.render(49)).toHaveLength(5)
  })
})
