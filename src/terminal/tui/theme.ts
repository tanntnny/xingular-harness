/*!
 * Adapted from @oh-my-pi/pi-tui 18.11.3 (https://github.com/can1357/oh-my-pi).
 *
 * MIT License
 *
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 * Copyright (c) 2026 Stencil Labs, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { Theme, type ThemeBg, type ThemeColor } from '@earendil-works/pi-coding-agent'

import { SELECTION_COLORS } from './selection'

const orange = { dark: '#ffb347', light: '#9a7326' } as const

/**
 * Categorical colours for a bar that splits one reading by kind — the same values as the App's
 * `--data-1..4` tokens, so a screen and a terminal show the same split in the same colours. They
 * carry no severity: a red run is a category, not a problem.
 */
export const SERIES_COLORS = {
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500'],
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100']
} as const

export const TITANIUM = {
  brushedTitanium: '#151820',
  darkTitanium: '#0f1216',
  electricBlue: '#00b4ff',
  deepBlue: '#0082b3',
  titaniumGold: '#d4c090',
  brightAluminum: '#e8ecf4',
  dimAluminum: '#9ca3b0',
  warningAmber: orange.dark,
  readoutGreen: '#00ff88',
  alertRed: '#ff4757',
  subtleGray: '#2a3038'
} as const

const foreground = {
  accent: '#00b4ff',
  border: '#2a3038',
  borderAccent: '#00b4ff',
  borderMuted: '#1f252d',
  success: '#00ff88',
  error: '#ff4757',
  warning: orange.dark,
  muted: '#9ca3b0',
  dim: '#6b7280',
  text: '',
  thinkingText: '#9ca3b0',
  userMessageText: '',
  customMessageText: '',
  customMessageLabel: '#d4c090',
  toolTitle: '',
  toolOutput: '#9ca3b0',
  mdHeading: '#00b4ff',
  mdLink: '#00b4ff',
  mdLinkUrl: '#0082b3',
  mdCode: '#00ff88',
  mdCodeBlock: '#9ca3b0',
  mdCodeBlockBorder: '#2a3038',
  mdQuote: '#9ca3b0',
  mdQuoteBorder: '#2a3038',
  mdHr: '#2a3038',
  mdListBullet: '#00b4ff',
  toolDiffAdded: '#00ff88',
  toolDiffRemoved: '#ff4757',
  toolDiffContext: '#9ca3b0',
  syntaxComment: '#6b7280',
  syntaxKeyword: '#00b4ff',
  syntaxFunction: '#00ff88',
  syntaxVariable: '#e8ecf4',
  syntaxString: '#d4c090',
  syntaxNumber: '#ffb347',
  syntaxType: '#00b4ff',
  syntaxOperator: '#00b4ff',
  syntaxPunctuation: '#9ca3b0',
  thinkingOff: '#4a5058',
  thinkingMinimal: '#5a6068',
  thinkingLow: '#6a7078',
  thinkingMedium: '#9ca3b0',
  thinkingHigh: '#00b4ff',
  thinkingXhigh: '#d4c090',
  bashMode: '#00ff88',
  scrollbarTrack: '#2a3038',
  scrollbarThumb: '#9ca3b0',
  searchMatchText: '#e8ecf4',
  thinkingMax: '#d4c090'
} satisfies Record<ThemeColor, string>

const background = {
  selectedBg: SELECTION_COLORS.dark.background,
  searchMatchBg: '#0082b3',
  userMessageBg: '#0f1216',
  customMessageBg: '#2a3038',
  toolPendingBg: '#0f1216',
  toolSuccessBg: '#0f1216',
  toolErrorBg: '#1a0f10'
} satisfies Record<ThemeBg, string>

export function createHarnessTheme(base: Theme): Theme {
  return new Theme(foreground, background, base.getColorMode(), { name: 'harness-titanium', appearance: 'dark' })
}

const lightForeground = {
  accent: '#5a8080',
  border: '#547da7',
  borderAccent: '#5a8080',
  borderMuted: '#b0b0b0',
  success: '#588458',
  error: '#aa5555',
  warning: orange.light,
  muted: '#6c6c6c',
  dim: '#767676',
  text: '',
  thinkingText: '#6c6c6c',
  userMessageText: '',
  customMessageText: '',
  customMessageLabel: '#7e57c2',
  toolTitle: '',
  toolOutput: '#6c6c6c',
  mdHeading: '#9a7326',
  mdLink: '#547da7',
  mdLinkUrl: '#767676',
  mdCode: '#5a8080',
  mdCodeBlock: '#588458',
  mdCodeBlockBorder: '#6c6c6c',
  mdQuote: '#6c6c6c',
  mdQuoteBorder: '#6c6c6c',
  mdHr: '#6c6c6c',
  mdListBullet: '#588458',
  toolDiffAdded: '#588458',
  toolDiffRemoved: '#aa5555',
  toolDiffContext: '#6c6c6c',
  syntaxComment: '#008000',
  syntaxKeyword: '#0000FF',
  syntaxFunction: '#795E26',
  syntaxVariable: '#001080',
  syntaxString: '#A31515',
  syntaxNumber: '#098658',
  syntaxType: '#267F99',
  syntaxOperator: '#000000',
  syntaxPunctuation: '#000000',
  thinkingOff: '#b0b0b0',
  thinkingMinimal: '#767676',
  thinkingLow: '#547da7',
  thinkingMedium: '#5a8080',
  thinkingHigh: '#875f87',
  thinkingXhigh: '#8b008b',
  bashMode: '#588458',
  scrollbarTrack: '#b0b0b0',
  scrollbarThumb: '#6c6c6c',
  searchMatchText: '#3b3b3b',
  thinkingMax: '#8b008b'
} satisfies Record<ThemeColor, string>

const lightBackground = {
  selectedBg: SELECTION_COLORS.light.background,
  searchMatchBg: '#d0d0e0',
  userMessageBg: '#e8e8e8',
  customMessageBg: '#ede7f6',
  toolPendingBg: '#e8e8f0',
  toolSuccessBg: '#e8f0e8',
  toolErrorBg: '#f0e8e8'
} satisfies Record<ThemeBg, string>

export function createHarnessLightTheme(base: Theme): Theme {
  return new Theme(lightForeground, lightBackground, base.getColorMode(), { name: 'light', appearance: 'light' })
}

// The composer keeps its neutral frame; the slash completion divider uses warning amber.
export function composerRuleColor(theme: Theme): string {
  return theme.appearance === 'light' ? '#9a9a9a' : '#999999'
}

export function autocompleteRuleColor(theme: Theme): string {
  return theme.appearance === 'light' ? orange.light : orange.dark
}
