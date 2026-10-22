// OpenCode's terminal palette, carried by the Harness's own product name.
import { SELECTION_COLORS } from '../tui/selection'

export interface OpenTuiTheme {
  background: string
  panel: string
  /** The translucent layer that dims the console behind a centered page dialog. */
  scrim: string
  border: string
  borderFocus: string
  text: string
  muted: string
  dim: string
  /** The shared selected-row field and its two text tones. */
  selectionBg: string
  selectionText: string
  selectionMuted: string
  questionSelectedBg: string
  questionActionBg: string
  questionActionText: string
  primary: string
  accent: string
  success: string
  warning: string
  error: string
  /** The composer's Bash mode marker and rules; the command body keeps the normal text color. */
  bashMode: string
  /** The composer's rules while plan mode is on. */
  planMode: string
  /** Image and pasted-text labels in the composer and in sent messages. */
  attachment: string
  purple: string
  cyan: string
}

export const opentuiTheme: OpenTuiTheme = {
  background: '#0b0b0d',
  panel: '#111114',
  scrim: '#0b0b0d99',
  border: '#2a2a31',
  borderFocus: '#3a3a44',
  text: '#e6e6e9',
  muted: '#8b8b95',
  dim: '#5c5c66',
  selectionBg: SELECTION_COLORS.dark.background,
  selectionText: SELECTION_COLORS.dark.text,
  selectionMuted: SELECTION_COLORS.dark.muted,
  questionSelectedBg: '#193322',
  questionActionBg: '#35754a',
  questionActionText: '#f7fff8',
  primary: '#fab283',
  accent: '#8ab4f8',
  success: '#a6da95',
  warning: '#eed49f',
  error: '#ed8796',
  bashMode: '#00ff88',
  planMode: '#8ab4f8',
  attachment: '#5ea1ff',
  purple: '#c6a0f6',
  cyan: '#8bd5ca'
}

export function blendHexColor(from: string, to: string, amount: number): string {
  const start = /^#([\da-f]{6})$/iu.exec(from)?.[1]
  const end = /^#([\da-f]{6})$/iu.exec(to)?.[1]
  if (!start || !end) return from

  const weight = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0
  const channels = [0, 2, 4].map(offset => {
    const first = Number.parseInt(start.slice(offset, offset + 2), 16)
    const second = Number.parseInt(end.slice(offset, offset + 2), 16)
    return Math.round(first + (second - first) * weight).toString(16).padStart(2, '0')
  })
  return `#${channels.join('')}`
}

export function composerRuleColor(
  theme: OpenTuiTheme,
  mode: { bash: boolean; plan: boolean; overlay: boolean }
): string {
  if (mode.bash) return theme.bashMode
  if (mode.plan) return theme.planMode
  return mode.overlay ? theme.border : theme.dim
}

export function noticeColor(theme: OpenTuiTheme, type: string): string {
  if (type === 'error') return theme.error
  if (type === 'warning') return theme.warning
  return theme.muted
}

export function toolColor(theme: OpenTuiTheme, status: 'running' | 'ok' | 'error' | 'pending'): string {
  if (status === 'error') return theme.error
  if (status === 'running') return theme.warning
  if (status === 'pending') return theme.dim
  return theme.success
}

export function thinkingLevelColor(theme: OpenTuiTheme, level: string): string {
  if (level === 'off') return theme.dim
  if (level === 'minimal' || level === 'low') return theme.muted
  if (level === 'medium') return theme.accent
  return theme.primary
}
