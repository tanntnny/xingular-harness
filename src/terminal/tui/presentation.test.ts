import type { Theme } from '@earendil-works/pi-coding-agent'
import { colorToHex, type TerminalColorMode } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'

import { createHarnessLightTheme, createHarnessTheme } from './theme'
import { SELECTION_COLORS } from './selection'

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
      selectedBg: SELECTION_COLORS.dark.background,
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
    expect(colorToHex(theme.colors.selectedBg)).toBe(SELECTION_COLORS.light.background)
    expect(colorToHex(theme.colors.toolSuccessBg)).toBe('#e8f0e8')
  })

  it('keeps the current terminal color mode', () => {
    const theme = titanium('256color')
    expect(theme.getColorMode()).toBe('256color')
  })
})
