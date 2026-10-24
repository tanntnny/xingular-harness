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

export function sketchViewportHeight(sketch: string, terminalHeight: number): number {
  // Compact screens reserve most rows for questions; taller screens can show a complete panel.
  return Math.min(sketch.split('\n').length, Math.max(1, Math.floor(terminalHeight / 3), terminalHeight - 20))
}
