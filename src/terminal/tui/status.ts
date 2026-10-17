// Presentation adapted from Oh My Pi 18.11.3's status line; it sits in the footer below the prompt frame.
// Upstream MIT license and evidence are recorded in NOTICE.md and docs/terminal-tui.md.
import { homedir } from 'node:os'
import { isAbsolute, relative, sep } from 'node:path'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { parseColor, stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

import { TITANIUM } from './theme'

export interface BandState {
  cwd: string
  model?: { name: string; reasoning: boolean; contextWindow: number }
  thinkingLevel: string
  branch: string | null
  account?: string
  contextPercent: number | null
  contextWindow: number
  costUsd: number
  subscription: boolean
  running: boolean
  elapsedMs: number
  hiddenAbove?: number
  hiddenBelow?: number
}

// OMP's shipped light theme supplies status colors separately from transcript colors.
const LIGHT_STATUS = {
  ...TITANIUM, darkTitanium: '#e0e0e0', electricBlue: '#875f87', subtleGray: '#808080',
  brightAluminum: '#005f87', readoutGreen: '#005f00', titaniumGold: '#005f5f'
}
const palette = (theme: Theme) => theme.appearance === 'light' ? LIGHT_STATUS : TITANIUM

const EFFORT: Record<string, string> = { off: '⦸', minimal: '○', low: '◔', medium: '◑', high: '◒', xhigh: '◕', max: '◉' }
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function singleLine(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/ +/g, ' ').trim()
}

export function displayPath(cwd: string, home = homedir()): string {
  const inside = relative(home, cwd)
  if (inside === '') return '~'
  return inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) ? `~${sep}${inside}` : cwd
}

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`
  if (tokens >= 1000) return `${Number((tokens / 1000).toFixed(1))}K`
  return String(Math.max(0, Math.round(tokens)))
}

function elapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
}

function color(theme: Theme, hex: string, text: string): string {
  return theme.style(text, { fg: parseColor(hex) })
}

export function contextGauge(width: number, percent: number | null, window: number, theme: Theme): string {
  const colors = palette(theme)
  const size = Math.max(0, Math.floor(width))
  if (!size) return ''
  const bounded = percent === null || !Number.isFinite(percent) ? null : Math.max(0, Math.min(100, percent))
  const used = window > 0 ? Math.min(size, Math.max(1, Math.round((bounded ?? 0) / 100 * size))) : 0
  const cells = Array.from({ length: size }, () => '─')
  const percentLabel = bounded === null ? '' : `${Math.round(bounded)}%`
  const windowLabel = window > 0 ? formatContextWindow(window) : ''
  const end = size - windowLabel.length - 1
  const start = Math.min(used, Math.max(1, end - percentLabel.length - 1))
  if (percentLabel && start + percentLabel.length < end) cells.splice(start, percentLabel.length, ...percentLabel)
  if (windowLabel && end > percentLabel.length + 2) cells.splice(end, windowLabel.length, ...windowLabel)
  return cells.map((cell, index) => color(theme, index < used ? colors.electricBlue : colors.subtleGray, cell)).join('')
}

export function renderStatusBand(state: BandState, width: number, theme: Theme): string {
  const colors = palette(theme)
  const size = Math.max(0, Math.floor(width))
  if (!size) return ''
  const model = state.model
  const effort = model?.reasoning ? EFFORT[state.thinkingLevel] ?? '○' : '⬢'
  const name = model ? singleLine(model.name).replace(/^Claude /, '') : 'no-model'
  const modelText = color(theme, colors.electricBlue, `${effort} ${name}`)
  const brand = color(theme, state.running ? colors.electricBlue : '#6b7280', state.running
    ? `${SPINNER[Math.floor(state.elapsedMs / 80) % SPINNER.length]} ${elapsed(state.elapsedMs)}` : 'π')
  const path = singleLine(displayPath(state.cwd))
  const separator = ` ${color(theme, colors.subtleGray, '>')} `
  const account = state.account ? color(theme, colors.brightAluminum, singleLine(state.account)) : null
  const branch = state.branch ? color(theme, colors.readoutGreen, `⑂ ${singleLine(state.branch)}`) : null
  const cost = state.costUsd > 0 || state.subscription
    ? color(theme, colors.titaniumGold, `$${state.costUsd.toFixed(2)}${state.subscription ? ' (sub)' : ''}`) : null
  const overflow = [state.hiddenAbove ? `↑ ${state.hiddenAbove} more` : '', state.hiddenBelow ? `↓ ${state.hiddenBelow} more` : ''].filter(Boolean).join(' ')
  const extra = overflow ? color(theme, '#6b7280', overflow) : null
  let pathWidth = Math.min(40, visibleWidth(path))
  let parts = [brand, modelText, color(theme, colors.brightAluminum, `📁 ${truncateToWidth(path, pathWidth)}`), account, branch, cost, extra].filter((part): part is string => part !== null)
  const minimumGauge = state.contextWindow > 0 ? Math.min(12, Math.floor(size / 3)) : 1
  const groupSize = () => visibleWidth(parts.join(separator)) + 3
  while (groupSize() + minimumGauge > size && pathWidth > 8) {
    pathWidth -= 1
    parts[2] = color(theme, colors.brightAluminum, `📁 ${truncateToWidth(path, pathWidth)}`)
  }
  while (groupSize() + minimumGauge > size && parts.length > 2) parts.pop()
  if (groupSize() + minimumGauge > size) parts = [modelText]
  const group = truncateToWidth(` ${parts.join(separator)} `, Math.max(0, size - 1), '', false)
  const cap = color(theme, colors.darkTitanium, '▶')
  const gauge = contextGauge(Math.max(0, size - visibleWidth(group) - 1), state.contextPercent, state.contextWindow, theme)
  return theme.style(group, { bg: parseColor(colors.darkTitanium) }) + cap + gauge
}
