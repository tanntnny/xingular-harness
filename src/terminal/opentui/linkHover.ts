// The hover affordance for a link: its own text changes colour, the way a pointer over a link
// changes it in a browser. A link is a per-cell attribute of the frame, not a renderable, so the
// cells carrying the hovered link's id are found in the frame and their foreground is repainted.
import type { OptimizedBuffer, RGBA } from '@opentui/core'

export interface HoverCell {
  x: number
  y: number
}

/** The renderer's link id at a cell, 0 when there is none. */
export type LinkIdAt = (x: number, y: number) => number

/** How far above and below the hovered row a wrapped link is looked for. */
const WRAPPED_ROWS = 2

/** The cells of one link: the rows it covers, bounded to a few rows around the pointer. */
export function hoveredLinkCells(linkIdAt: LinkIdAt, id: number, at: { x: number; y: number }, width: number, height: number): HoverCell[] {
  if (!id || at.x < 0 || at.y < 0 || at.x >= width || at.y >= height) return []
  if (linkIdAt(at.x, at.y) !== id) return []
  const cells: HoverCell[] = []
  const row = (top: number): boolean => {
    if (top < 0 || top >= height) return false
    let start = -1
    let end = -1
    for (let x = 0; x < width; x++) {
      if (linkIdAt(x, top) === id) {
        if (start < 0) start = x
        end = x
      } else if (start >= 0) {
        break
      }
    }
    if (start < 0) return false
    for (let x = start; x <= end; x++) cells.push({ x, y: top })
    return true
  }
  row(at.y)
  let misses = 0
  for (let distance = 1; distance <= WRAPPED_ROWS && misses < 2; distance++) {
    const above = row(at.y - distance)
    const below = row(at.y + distance)
    misses = above || below ? 0 : misses + 1
  }
  return cells
}

/** Repaints the foreground of those cells in the hover colour, keeping every other cell attribute. */
export function paintLinkCells(buffer: OptimizedBuffer, cells: readonly HoverCell[], color: RGBA): number {
  if (!cells.length) return 0
  const [r, g, b, a] = color.toInts()
  let painted = 0
  buffer.withBuffers(plane => {
    const foreground = plane.fg as Uint16Array
    for (const cell of cells) {
      const index = (cell.y * plane.width + cell.x) * 4
      if (index < 0 || index + 3 >= foreground.length) continue
      foreground[index] = r
      foreground[index + 1] = g
      foreground[index + 2] = b
      foreground[index + 3] = a
      painted += 1
    }
  })
  return painted
}
