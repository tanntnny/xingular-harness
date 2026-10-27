import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { formatTerminalCommandLabel } from '../commandHelp'

export interface PaletteItem {
  name: string
  aliases?: string[]
  description?: string
  prefix?: '/' | '$'
}

/**
 * Fits the slash-command column to visible names while reserving at least half the row for
 * descriptions. The row has six columns of surrounding padding and a two-column gutter.
 */
export function paletteCommandColumnWidth(items: readonly PaletteItem[], terminalWidth: number): number {
  const widestName = items.reduce((width, item) => Math.max(width, formatTerminalCommandLabel(item.name, item.aliases).length + 1), 1)
  const commandLimit = Math.max(1, Math.floor((terminalWidth - 8) / 2))
  return Math.min(widestName, commandLimit)
}

export function paletteTextLines(text: string, width: number): string[] {
  const columns = Math.max(1, width)
  const safe = stripTerminalSequences(text).replace(/[\x00-\x09\x0b-\x1f\x7f]/gu, ' ')
  const lines = safe.split('\n').flatMap(line => line ? wrapTextWithAnsi(line, columns) : [''])
  if (lines.length <= 3) return lines
  const result = lines.slice(0, 3)
  result[2] = `${truncateToWidth(result[2] ?? '', columns - 1, '', false)}…`
  return result
}

/** The order a match earns: an exact name or alias, a prefix, part of a name, then only a description. */
function rank(item: PaletteItem, query: string): number {
  const names = [item.name, ...(item.aliases ?? [])].map(name => name.toLowerCase())
  if (names.some(name => name === query)) return 0
  if (names.some(name => name.startsWith(query))) return 1
  if (names.some(name => name.includes(query))) return 2
  if (item.description?.toLowerCase().includes(query)) return 3
  return -1
}

/**
 * The commands matching a filter, best match first. A name or alias beats a description, so
 * typing `/account` offers `/accounts` before `/session (resume)` even if its description mentions an account.
 */
export function matchPalette(items: readonly PaletteItem[], filter: string): PaletteItem[] {
  const query = filter.toLowerCase()
  if (!query) return [...items]
  return items
    .map((item, order) => ({ item, order, rank: rank(item, query) }))
    .filter(entry => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(entry => entry.item)
}
