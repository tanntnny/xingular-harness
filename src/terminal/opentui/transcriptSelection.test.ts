import { describe, expect, it } from 'vitest'
import type { Selection } from '@opentui/core'

import { transcriptSelectionText } from './transcriptSelection'

interface Node {
  parent: Node | null
}

function node(parent: Node | null = null): Node {
  return { parent }
}

function selection(options: {
  text: string
  selected: Node[]
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

describe('transcriptSelectionText', () => {
  it('returns selected plain text when every selected renderable belongs to the transcript', () => {
    const transcript = node()
    const item = node(transcript)
    const text = node(item)

    expect(transcriptSelectionText(selection({ text: 'selected\nchat', selected: [text, node(item)] }), transcript)).toBe('selected\nchat')
  })

  it('copies intentional word or line selections without requiring the pointer to move', () => {
    const transcript = node()
    const text = node(transcript)
    const samePoint = { x: 1, y: 1 }

    expect(transcriptSelectionText(selection({
      text: 'word', selected: [text], behavior: 'word', anchor: samePoint, focus: samePoint
    }), transcript)).toBe('word')
    expect(transcriptSelectionText(selection({
      text: 'whole line', selected: [text], behavior: 'line', anchor: samePoint, focus: samePoint
    }), transcript)).toBe('whole line')
  })

  it('ignores a single-cell click and selections outside or crossing the transcript boundary', () => {
    const transcript = node()
    const inside = node(transcript)
    const outside = node()
    const samePoint = { x: 1, y: 1 }

    expect(transcriptSelectionText(selection({
      text: 'x', selected: [inside], anchor: samePoint, focus: samePoint
    }), transcript)).toBeUndefined()
    expect(transcriptSelectionText(selection({ text: 'dialog', selected: [outside] }), transcript)).toBeUndefined()
    expect(transcriptSelectionText(selection({ text: 'crossing', selected: [inside, outside] }), transcript)).toBeUndefined()
  })

  it('ignores empty selections and whitespace-only text', () => {
    const transcript = node()
    const text = node(transcript)

    expect(transcriptSelectionText(selection({ text: '', selected: [text] }), transcript)).toBeUndefined()
    expect(transcriptSelectionText(selection({ text: '  \n ', selected: [text] }), transcript)).toBeUndefined()
    expect(transcriptSelectionText(selection({ text: 'text', selected: [] }), transcript)).toBeUndefined()
    expect(transcriptSelectionText(selection({ text: 'text', selected: [text] }), undefined)).toBeUndefined()
  })
})
