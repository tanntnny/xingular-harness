import type { BorderCharacters } from '@opentui/core'

/** Every row uses the same cell widths, independently of its text or recommendation. */
export function questionDockColumns(availableWidth: number): { marker: number; label: number; gap: number; description: number } {
  const width = Math.max(0, Math.floor(availableWidth))
  const marker = Math.min(2, Math.max(0, width - 2))
  const gap = Math.min(2, Math.max(0, width - marker - 2))
  const remaining = width - marker - gap
  const label = Math.max(0, Math.floor(remaining / 3))
  return { marker, label, gap, description: remaining - label }
}

export const sketchBorder: BorderCharacters = {
  topLeft: '┌', topRight: '┐', bottomLeft: '└', bottomRight: '┘',
  horizontal: '─', vertical: '│', topT: '┬', bottomT: '┴', leftT: '├', rightT: '┤', cross: '┼'
}

export function questionDockAnswerWidth(contentWidth: number, optionCount: number, actionLabel: string): number {
  const actionWidth = actionLabel.length + 2
  const answerRowInsets = 14
  return Math.max(1, Math.floor(contentWidth) - String(optionCount + 1).length - actionWidth - answerRowInsets)
}

export function questionDockBodyHeight(contentTop: number, children: readonly { y: number; height: number }[], maxHeight: number): number {
  const contentBottom = children.reduce((bottom, child) => Math.max(bottom, child.y + child.height), contentTop)
  return Math.max(1, Math.min(Math.ceil(contentBottom - contentTop), Math.floor(maxHeight)))
}

export function questionDockPreviewRevealDelta(viewportTop: number, viewportHeight: number, previewTop: number, previewHeight: number, direction: -1 | 1): number {
  const topOverflow = viewportTop - previewTop
  const bottomOverflow = previewTop + previewHeight - (viewportTop + viewportHeight)
  if (previewHeight > viewportHeight) return direction < 0 ? -Math.ceil(Math.max(0, topOverflow)) : Math.ceil(Math.max(0, bottomOverflow))
  if (topOverflow > 0) return -Math.ceil(topOverflow)
  if (bottomOverflow > 0) return Math.ceil(bottomOverflow)
  return 0
}

export function sketchViewportHeight(sketch: string, terminalHeight: number): number {
  // Compact screens reserve most rows for questions; taller screens can show a complete panel.
  return Math.min(sketch.split('\n').length, Math.max(1, Math.floor(terminalHeight / 3), terminalHeight - 20))
}
