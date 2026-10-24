import { describe, expect, it } from 'vitest'
import type { Selection } from '@opentui/core'

import { terminalSelectionText } from './terminalSelection'

function node(): object {
  return {}
}

function selection(options: {
  text: string
  selected: object[]
  behavior?: 'cell' | 'word' | 'line'
  anchor?: { x: number; y: number }
  focus?: { x: number; y: number }
}): Selection {
  return {
    behavior: options.behavior ?? 'cell',
    anchor: options.anchor ?? { x: 1, y: 1 },
    focus: options.focus ?? { x: 2, y: 1 },
    selectedRenderables: options.selected,
    getSelectedText: () => options.text
  } as unknown as Selection
}

describe('terminalSelectionText', () => {
  it('returns selected plain text from any TUI renderables', () => {
    const composer = node()
    const dialog = node()

    expect(terminalSelectionText(selection({ text: 'composer and dialog text', selected: [composer, dialog] }))).toBe('composer and dialog text')
  })

  it('copies intentional word or line selections without requiring the pointer to move', () => {
    const text = node()
    const samePoint = { x: 1, y: 1 }

    expect(terminalSelectionText(selection({
      text: 'word', selected: [text], behavior: 'word', anchor: samePoint, focus: samePoint
    }))).toBe('word')
    expect(terminalSelectionText(selection({
      text: 'whole line', selected: [text], behavior: 'line', anchor: samePoint, focus: samePoint
    }))).toBe('whole line')
  })

  it('ignores a single-cell click', () => {
    const samePoint = { x: 1, y: 1 }

    expect(terminalSelectionText(selection({
      text: 'x', selected: [node()], anchor: samePoint, focus: samePoint
    }))).toBeUndefined()
  })

  it('ignores empty selections and whitespace-only text', () => {
    expect(terminalSelectionText(selection({ text: '', selected: [node()] }))).toBeUndefined()
    expect(terminalSelectionText(selection({ text: '  \n ', selected: [node()] }))).toBeUndefined()
    expect(terminalSelectionText(selection({ text: 'text', selected: [] }))).toBeUndefined()
  })
})
