// Presentation adapted from Oh My Pi 18.11.3's status line; it sits in the footer below the prompt frame.
// Upstream MIT license and evidence are recorded in NOTICE.md and docs/terminal-tui.md.
import { basename, sep } from 'node:path'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { parseColor, stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

import { TITANIUM } from './theme'

export interface BandState {
  cwd: string
  model?: { name: string; reasoning: boolean; contextWindow: number }
  thinkingLevel: string
  branch: string | null
  account?: string
  inputTokens: number
  outputTokens: number
  tokensPerSecond: number | null
}

// OMP's shipped light theme supplies status colors separately from transcript colors.
const LIGHT_STATUS = {
  ...TITANIUM, darkTitanium: '#e0e0e0', electricBlue: '#875f87', subtleGray: '#808080',
  brightAluminum: '#005f87', readoutGreen: '#005f00', titaniumGold: '#005f5f'
}
const palette = (theme: Theme) => theme.appearance === 'light' ? LIGHT_STATUS : TITANIUM

type StatusPart = { text: string; color: string }

export function singleLine(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/ +/g, ' ').trim()
}

export function displayProjectName(cwd: string): string {
  return singleLine(basename(cwd) || cwd || sep)
}

function tokenCount(value: number): string {
  return Math.max(0, Number.isFinite(value) ? Math.round(value) : 0).toLocaleString('en-US')
}

function fitParts(parts: StatusPart[], width: number): StatusPart[] {
  const fitted = parts.map(part => ({ ...part }))
  const separator = ' | '
  const plain = () => fitted.map(part => part.text).join(separator)
  while (fitted.length > 1 && visibleWidth(plain()) > width) {
    const last = fitted[fitted.length - 1]
    const otherWidth = visibleWidth(plain()) - visibleWidth(separator) - visibleWidth(last.text)
    const available = width - otherWidth - visibleWidth(separator)
    if (available > 0 && available < visibleWidth(last.text)) {
      last.text = truncateToWidth(last.text, available, '', false)
      if (visibleWidth(plain()) <= width) return fitted
    }
    fitted.pop()
  }
  if (fitted.length && visibleWidth(plain()) > width) {
    fitted[0].text = truncateToWidth(fitted[0].text, width, '', false)
  }
  return fitted
}

function color(theme: Theme, hex: string, text: string): string {
  return theme.style(text, { fg: parseColor(hex) })
}

export function renderStatusBand(state: BandState, width: number, theme: Theme): string {
  const size = Math.max(0, Math.floor(width))
  if (!size) return ''
  const colors = palette(theme)
  const model = state.model ? singleLine(state.model.name).replace(/^Claude /, '') || 'no-model' : 'no-model'
  const account = singleLine(state.account ?? '') || 'account unknown'
  const effort = singleLine(state.thinkingLevel) || 'off'
  const rate = state.tokensPerSecond === null || !Number.isFinite(state.tokensPerSecond)
    ? '— tok/s' : `${Math.max(0, Math.round(state.tokensPerSecond))} tok/s`
  const parts = fitParts([
    { text: displayProjectName(state.cwd), color: colors.brightAluminum },
    { text: singleLine(state.branch ?? '') || '—', color: colors.readoutGreen },
    { text: `${account} · ${model} · ${effort}`, color: colors.electricBlue },
    { text: `${rate} in ${tokenCount(state.inputTokens)} out ${tokenCount(state.outputTokens)}`, color: colors.titaniumGold }
  ], size)
  const separator = color(theme, colors.subtleGray, ' | ')
  return parts.map(part => color(theme, part.color, part.text)).join(separator)
}
