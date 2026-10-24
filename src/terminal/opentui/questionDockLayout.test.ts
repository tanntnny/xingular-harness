import { describe, expect, it } from 'vitest'

import { questionDockColumns, sketchBorder, sketchViewportHeight } from './questionDockLayout'

describe('question dock geometry', () => {
  it.each([0, 1, 2, 3, 8, 32, 40, 60, 80, 120])('fits strictly aligned cells in %i columns', width => {
    const cells = questionDockColumns(width)
    expect(cells.marker + cells.label + cells.gap + cells.description).toBe(width)
    expect(Object.values(cells).every(value => value >= 0)).toBe(true)
    if (width >= 8) {
      expect(cells.marker).toBe(2)
      expect(cells.gap).toBe(2)
      expect(cells.label).toBeGreaterThan(0)
      expect(cells.description).toBeGreaterThanOrEqual(cells.label)
    }
  })

  it('does not depend on option text, missing descriptions or recommendation markers', () => {
    const options = [{ label: 'Short' }, { label: 'Unspaced'.repeat(30), description: 'Long'.repeat(50), recommended: true }]
    const starts = options.map(() => {
      const cells = questionDockColumns(36)
      return cells.marker + cells.label + cells.gap
    })
    expect(new Set(starts).size).toBe(1)
    expect(questionDockColumns(116).label).toBeGreaterThan(questionDockColumns(36).label)
    expect(questionDockColumns(36)).toEqual({ marker: 2, label: 10, gap: 2, description: 22 })
  })

  it('bounds sketch height without reflowing or discarding lines', () => {
    const sketch = Array(24).fill('| a panel |').join('\n')
    expect(sketchViewportHeight(sketch, 20)).toBe(6)
    expect(sketchViewportHeight(sketch, 40)).toBe(20)
    expect(sketchViewportHeight('small', 40)).toBe(1)
    expect(sketchViewportHeight(sketch, 1)).toBe(1)
    expect(sketchBorder).toMatchObject({ topLeft: '┌', bottomRight: '┘', horizontal: '─', vertical: '│' })
  })
})
