// Shared chrome for terminal surfaces. A surface is either a block, which docks above the composer
// like the slash-command list, or a page, which fills the screen. Neither draws a box: only
// horizontal rules, and no text sits on a rule.
import type { Theme } from '@earendil-works/pi-coding-agent'
import { parseColor, stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

import { SELECTION_COLORS } from './selection'

/** Cells kept clear on each side of a row, the width of the composer's `❯` gutter. */
export const CHROME_PAD = 2
/** Rows a frame spends on itself: header, footer and two rules. */
export const CHROME_ROWS = 4
export const CENTER_DIALOG_PAD = 4
/** Terminal rows are roughly twice as tall as character columns, so 2 rows match 4 columns. */
export const CENTER_DIALOG_VERTICAL_PAD = 2

export function safeText(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f]/g, ' ')
}

/** Fills a selected row with the shared background without changing its text styling. */
export function selectedRow(line: string, width: number, theme: Theme): string {
  if (width < 1) return ''
  const bounded = truncateToWidth(line, width, '')
  return theme.bg('selectedBg', bounded + ' '.repeat(Math.max(0, width - visibleWidth(bounded))))
}

function selectionPalette(theme: Theme) {
  return theme.appearance === 'light' ? SELECTION_COLORS.light : SELECTION_COLORS.dark
}

/** Primary text on a selected row, explicit so no accent colour sits on the blue field. */
export function selectionText(theme: Theme, text: string): string {
  return theme.style(text, { fg: parseColor(selectionPalette(theme).text) })
}

/** Secondary text on a selected row: quieter than the label but still readable on the blue. */
export function selectionMuted(theme: Theme, text: string): string {
  return theme.style(text, { fg: parseColor(selectionPalette(theme).muted) })
}

/** The width a surface's content is laid out in. */
export function contentWidth(width: number): number {
  return Math.max(2, width - CHROME_PAD * 2)
}

/** Content width after the four-cell inset on each side of a centered dialog. */
export function centerDialogContentWidth(width: number): number {
  return Math.max(1, width - CENTER_DIALOG_PAD * 2)
}

export function centerDialogVerticalPad(rows: number): number {
  return Math.min(CENTER_DIALOG_VERTICAL_PAD, Math.max(0, Math.floor((Math.trunc(rows) - 2) / 2)))
}

/** Header and its following gap, plus fixed top and bottom padding, at the available height. */
export function centerDialogChromeRows(rows: number): number {
  const pad = centerDialogVerticalPad(rows)
  return pad * 2 + 2
}

export function centerDialogBodyRows(rows: number): number {
  return Math.max(0, Math.trunc(rows) - centerDialogChromeRows(rows))
}

/** A centered dialog: plain title, muted Escape hint, and generous inset with no rules or footer. */
export function centerDialogFrame({ title, body, width, rows, theme }: Pick<FrameInput, 'title' | 'body' | 'width' | 'theme'> & { rows: number }): string[] {
  rows = Math.max(0, Math.trunc(rows))
  if (width < 1 || rows < 1) return []
  const pad = Math.min(CENTER_DIALOG_PAD, Math.floor(width / 2))
  const verticalPad = centerDialogVerticalPad(rows)
  const room = Math.max(0, width - pad * 2)
  const name = truncateToWidth(safeText(title), Math.max(0, room - 4), '')
  const heading = ' '.repeat(pad) + theme.fg('text', name) + ' '.repeat(Math.max(1, room - visibleWidth(name) - 3)) + theme.fg('muted', 'Esc')
  const shown = body.slice(0, centerDialogBodyRows(rows)).map(line => truncateToWidth(' '.repeat(pad) + line, width, ''))
  return [
    ...Array.from({ length: verticalPad }, () => ''),
    truncateToWidth(heading, width, ''),
    '',
    ...shown,
    ...Array.from({ length: verticalPad }, () => '')
  ].slice(0, rows)
}

/** The divider above a block: the `warning` amber the slash-command list's divider uses. */
export function blockRule(width: number, theme: Theme): string {
  return width > 0 ? theme.fg('warning', '─'.repeat(width)) : ''
}

/** The neutral rule that closes a block and frames a page, like the composer's own rules. */
export function neutralRule(width: number, theme: Theme): string {
  return width > 0 ? theme.fg('dim', '─'.repeat(width)) : ''
}

/** A row indented by the chrome padding and clipped to the width. */
export function padded(line: string, width: number): string {
  return truncateToWidth(' '.repeat(Math.min(CHROME_PAD, width)) + line, width, '')
}

/** A bold title with an optional dim note at the right edge. */
export function headerRow(title: string, meta: string | undefined, width: number, theme: Theme): string {
  const room = Math.max(0, width - CHROME_PAD * 2)
  const name = truncateToWidth(safeText(title), room, '')
  const note = meta ? truncateToWidth(safeText(meta), Math.max(0, room - visibleWidth(name) - 2), '') : ''
  const gap = Math.max(0, room - visibleWidth(name) - visibleWidth(note))
  return padded(theme.bold(theme.fg('accent', name)) + ' '.repeat(gap) + (note ? theme.fg('dim', note) : ''), width)
}

export interface TabInfo { id: string; title: string }

/**
 * The topmost row of a console page, or a page's sub-strip. Too narrow for every title, it
 * collapses to the active one with its place: `‹ Accounts 1/7 ›`. `width` is the content width.
 */
export function tabIndexAt(tabs: readonly TabInfo[], width: number, x: number, kind: 'top' | 'sub' = 'top'): number | undefined {
  if (x < 0 || x >= width || tabs.length === 0) return undefined
  const labels = tabs.map(tab => kind === 'sub' ? safeText(tab.title) : ` ${safeText(tab.title)} `)
  const gap = kind === 'sub' ? ' · ' : ' '
  const total = labels.reduce((sum, label) => sum + visibleWidth(label), 0) + Math.max(0, tabs.length - 1) * visibleWidth(gap)
  if (total > width) return undefined
  let cursor = 0
  for (let index = 0; index < labels.length; index += 1) {
    const end = cursor + visibleWidth(labels[index]!)
    if (x < end) return index
    if (index < labels.length - 1) {
      const next = end + visibleWidth(gap)
      if (x < next) return x - end < next - x ? index : index + 1
      cursor = next
    }
  }
  return labels.length - 1
}

export function tabStrip(tabs: readonly TabInfo[], activeId: string, width: number, theme: Theme, kind: 'top' | 'sub' = 'top', hoveredId?: string): string {
  if (width < 1 || !tabs.length) return ''
  const active = Math.max(0, tabs.findIndex(tab => tab.id === activeId))
  const full = tabs.map((tab, index) => {
    const title = safeText(tab.title)
    const selected = index === active || tab.id === hoveredId
    if (kind === 'sub') {
      if (index === active) return theme.bold(selectionText(theme, title))
      return tab.id === hoveredId ? theme.bg('selectedBg', theme.bold(selectionText(theme, title))) : theme.fg('dim', title)
    }
    return selected ? theme.bg('selectedBg', theme.bold(selectionText(theme, ` ${title} `))) : theme.fg('muted', ` ${title} `)
  }).join(kind === 'sub' ? theme.fg('dim', ' · ') : ' ')
  if (visibleWidth(full) <= width) return full
  return truncateToWidth(theme.bg('selectedBg', theme.bold(selectionText(theme, `‹ ${safeText(tabs[active]!.title)} ${active + 1}/${tabs.length} ›`))), width, '')
}

/** The hint row at the foot of a surface. */
export function footerRow(text: string, width: number, theme: Theme): string {
  return padded(theme.fg('dim', truncateToWidth(safeText(text), Math.max(0, width - CHROME_PAD * 2), '')), width)
}

export interface FrameInput {
  title: string
  meta?: string
  body: readonly string[]
  footer: string
  width: number
  theme: Theme
}

/** A block: amber rule, title, body, hint, neutral rule. It is as tall as its body. */
export function blockFrame({ title, meta, body, footer, width, theme }: FrameInput): string[] {
  if (width < 1) return []
  return [
    blockRule(width, theme),
    headerRow(title, meta, width, theme),
    ...body.map(line => padded(line, width)),
    footerRow(footer, width, theme),
    neutralRule(width, theme)
  ]
}

/** Rows a page leaves for its body at a given terminal height. */
export function pageBodyRows(rows: number): number {
  return Math.max(0, Math.trunc(rows) - CHROME_ROWS)
}

/** A page: title (or `headerLine`, such as a tab strip), rule, body padded to fill the screen, rule, hint. */
export function pageFrame({ title, meta, body, footer, width, rows, theme, headerLine }: FrameInput & { rows: number; headerLine?: string }): string[] {
  rows = Math.max(0, Math.trunc(rows))
  if (width < 1 || rows < 1) return []
  const room = pageBodyRows(rows)
  const shown = body.slice(0, room).map(line => padded(line, width))
  while (shown.length < room) shown.push('')
  return [
    headerLine === undefined ? headerRow(title, meta, width, theme) : padded(headerLine, width),
    neutralRule(width, theme),
    ...shown,
    neutralRule(width, theme),
    footerRow(footer, width, theme)
  ].slice(0, rows)
}
