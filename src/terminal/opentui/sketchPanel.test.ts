import { describe, expect, it } from 'vitest'

import { layoutSketchPanel } from './sketchPanel'

const visibleLines = (sketch: string, width = 1) => layoutSketchPanel(sketch, width).text.split('\n').map(line => line.trimEnd())

describe('connected sketch panels', () => {
  it('turns a closed ASCII table into connected corners, dividers and intersections', () => {
    const source = '+---+---+\n| A | B |\n+---+---+\n| C | D |\n+---+---+'
    expect(visibleLines(source)).toEqual([
      '┌───┬───┐', '│ A │ B │', '├───┼───┤', '│ C │ D │', '└───┴───┘'
    ])
    expect(source).toContain('+---+---+')
  })

  it.each([16, 40, 80, 120])('sizes standalone dividers to the %i-column panel, not the original dashes', width => {
    const panel = layoutSketchPanel('Product\n-----\n> Ask anything...\n---\nfolder | account | model', width)
    expect(panel.width).toBe(Math.max(width, 'folder | account | model'.length))
    expect(panel.dividers).toEqual([1, 3])
    expect(panel.text.split('\n')[1]).toBe('─'.repeat(panel.width))
    expect(panel.text.split('\n')[3]).toBe('─'.repeat(panel.width))
    expect(panel.text).toContain('folder | account | model')
  })

  it('keeps a nested table at its own width instead of stretching it to the outer panel', () => {
    const panel = layoutSketchPanel('Neighbors\n+---+\n| A |\n+---+', 40)
    expect(panel.width).toBe(40)
    expect(panel.dividers).toEqual([])
    expect(visibleLines('Neighbors\n+---+\n| A |\n+---+', 40)).toEqual(['Neighbors', '┌───┐', '│ A │', '└───┘'])
  })

  it('connects a title-bearing frame and repairs missing or whitespace-shifted side edges', () => {
    const top = '+--- Empty welcome ---+'
    const right = top.length - 1
    const shiftedPrefix = '| One run'
    const shifted = `${shiftedPrefix}${' '.repeat(right + 1 - shiftedPrefix.length)}|`
    const bottom = `+${'-'.repeat(right - 1)}+`
    const source = [top, '| Welcome', shifted, bottom].join('\n')
    const rows = layoutSketchPanel(source, 1).text.split('\n')

    expect(rows[0]).toMatch(/^┌─+ Empty welcome ─+┐\s*$/u)
    for (const row of rows.slice(1, -1)) {
      expect(row![0]).toBe('│')
      expect(row![right]).toBe('│')
    }
    expect(rows[2]![right + 1]).toBe(' ')
    expect(rows[2]!.slice(1, right)).toContain('One run')
    expect(rows.at(-1)![0]).toBe('└')
    expect(rows.at(-1)![right]).toBe('┘')
    expect(source).toBe([top, '| Welcome', shifted, bottom].join('\n'))
  })

  it('does not infer missing edges without matching frame rules', () => {
    const top = '+--- Panel ---+'
    const source = `${top}\n| content |\n+----+`
    const rendered = layoutSketchPanel(source, 1).text.split('\n')
    expect(rendered[1]![top.length - 1]).not.toBe('│')
  })

  it('does not reinterpret prose, arithmetic, Markdown-like text or command pipes as borders', () => {
    const source = '[ORANGE] /model | /help\na+b - c\n--flag\n**bold**\n| only a quote\n   \nend  '
    const panel = layoutSketchPanel(source, 40)
    expect(panel.dividers).toEqual([])
    source.split('\n').forEach((line, index) => {
      expect(panel.text.split('\n')[index]).toBe(line.padEnd(panel.width, ' '))
    })
  })

  it('preserves blank lines, labels and trailing spaces in the source without mutating metadata', () => {
    const source = '\n+--+\n| A| \n+--+\n\n'
    expect(visibleLines(source)).toEqual(['', '┌──┐', '│ A│', '└──┘', '', ''])
    expect(source).toBe('\n+--+\n| A| \n+--+\n\n')
  })
})
