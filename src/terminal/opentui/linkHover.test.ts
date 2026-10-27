import { RGBA, type OptimizedBuffer } from '@opentui/core'
import { describe, expect, it } from 'vitest'

import { hoveredLinkCells, paintLinkCells } from './linkHover'

/** A grid of link ids, addressed the way the renderer addresses cells. */
function grid(rows: number[][]): (x: number, y: number) => number {
  return (x, y) => rows[y]?.[x] ?? 0
}

describe('the cells of the link under the pointer', () => {
  it('takes the run on the hovered row and the rows a wrapped link continues onto', () => {
    const linkIdAt = grid([
      [0, 0, 0, 0, 0],
      [0, 7, 7, 0, 0],
      [7, 7, 0, 0, 0],
      [0, 0, 0, 9, 9],
      [0, 0, 0, 0, 0]
    ])
    expect(hoveredLinkCells(linkIdAt, 7, { x: 2, y: 1 }, 5, 5)).toEqual([
      { x: 1, y: 1 }, { x: 2, y: 1 },
      { x: 0, y: 2 }, { x: 1, y: 2 }
    ])
    expect(hoveredLinkCells(linkIdAt, 9, { x: 4, y: 3 }, 5, 5)).toEqual([{ x: 3, y: 3 }, { x: 4, y: 3 }])
  })

  it('finds nothing when the pointer is not on that link, or the cell is off the frame', () => {
    const linkIdAt = grid([[0, 7, 7]])
    expect(hoveredLinkCells(linkIdAt, 7, { x: 0, y: 0 }, 3, 1)).toEqual([])
    expect(hoveredLinkCells(linkIdAt, 0, { x: 1, y: 0 }, 3, 1)).toEqual([])
    expect(hoveredLinkCells(linkIdAt, 7, { x: 1, y: 9 }, 3, 1)).toEqual([])
    expect(hoveredLinkCells(linkIdAt, 7, { x: -1, y: 0 }, 3, 1)).toEqual([])
  })
})

describe('repainting the hovered link', () => {
  it('writes the hover colour into the foreground plane of exactly those cells', () => {
    const width = 4
    const foreground = new Uint16Array(width * 2 * 4).fill(9)
    const buffer = {
      withBuffers: (callback: (plane: unknown) => void) => callback({ width, height: 2, fg: foreground, bg: foreground, char: foreground, attributes: foreground, generation: 1n })
    } as unknown as OptimizedBuffer

    expect(paintLinkCells(buffer, [{ x: 1, y: 0 }, { x: 2, y: 1 }], RGBA.fromHex('#c9ddff'))).toBe(2)
    const [r, g, b, a] = RGBA.fromHex('#c9ddff').toInts()
    expect([...foreground.slice(4, 8)]).toEqual([r, g, b, a])
    expect([...foreground.slice(24, 28)]).toEqual([r, g, b, a])
    expect([...foreground.slice(0, 4)]).toEqual([9, 9, 9, 9])
    expect([...foreground.slice(8, 12)]).toEqual([9, 9, 9, 9])
  })

  it('does nothing for an empty set of cells', () => {
    const buffer = { withBuffers: () => { throw new Error('no frame access expected') } } as unknown as OptimizedBuffer
    expect(paintLinkCells(buffer, [], RGBA.fromHex('#c9ddff'))).toBe(0)
  })
})
