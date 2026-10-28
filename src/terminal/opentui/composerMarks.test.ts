import { describe, expect, it } from 'vitest'

import { bufferOffset, indexForBufferOffset, syncSkillInvocationMark, syncSlashCommandMark, type MarkTarget } from './composerMarks'

function target(initial: string) {
  let text = initial
  let nextId = 1
  const marks = new Map<number, { id: number; start: number; end: number; styleId?: number; typeId?: number }>()
  const value: MarkTarget = {
    get plainText() { return text },
    extmarks: {
      create: options => {
        const id = nextId++
        marks.set(id, { id, start: options.start, end: options.end, styleId: options.styleId, typeId: options.typeId })
        return id
      },
      delete: id => marks.delete(id),
      getAllForTypeId: typeId => [...marks.values()].filter(mark => mark.typeId === typeId)
    },
    editBuffer: {
      getTextRange: (start, end) => text.slice(start, end),
      offsetToPosition: () => null,
      deleteRange: () => {}
    }
  }
  return { value, marks, setText: (next: string) => { text = next } }
}

describe('composer slash command marks', () => {
  it('marks only the recognized command token and removes stale marks', () => {
    const { value, marks, setText } = target('　/help argument')

    syncSlashCommandMark(value, ['help'], 3, 7)
    expect([...marks.values()]).toEqual([{ id: 1, start: 2, end: 7, styleId: 7, typeId: 3 }])

    syncSlashCommandMark(value, ['help'], 3, 7)
    expect(marks.size).toBe(1)

    setText(' /unknown argument')
    syncSlashCommandMark(value, ['help'], 3, 7)
    expect(marks.size).toBe(0)
  })
})

describe('composer skill invocation marks', () => {
  it('marks every enabled skill token, wherever it is in the message', () => {
    const { value, marks, setText } = target('Read $review then $deploy later')

    syncSkillInvocationMark(value, ['review', 'deploy'], 4, 9)
    expect([...marks.values()]).toEqual([
      { id: 1, start: 5, end: 12, styleId: 9, typeId: 4 },
      { id: 2, start: 18, end: 25, styleId: 9, typeId: 4 }
    ])
    syncSkillInvocationMark(value, ['review', 'deploy'], 4, 9)
    expect(marks.size).toBe(2)

    setText('Read $review later')
    syncSkillInvocationMark(value, ['review', 'deploy'], 4, 9)
    expect([...marks.values()]).toEqual([{ id: 3, start: 5, end: 12, styleId: 9, typeId: 4 }])
  })

  it('leaves unknown names, currency and mid-word dollars unmarked', () => {
    const { value, marks, setText } = target('  $review inspect this')
    for (const text of ['$unknown inspect this', '$5 total', 'cost$review here']) {
      setText(text)
      syncSkillInvocationMark(value, ['review'], 4, 9)
      expect(marks.size).toBe(0)
    }
  })
})

describe('cell offsets in the composer', () => {
  it('converts a string index to a cell offset and back', () => {
    const text = 'a😀b\nc'
    let index = 0
    for (const character of text) {
      expect(indexForBufferOffset(text, bufferOffset(text, index))).toBe(index)
      index += character.length
    }
    expect(indexForBufferOffset(text, bufferOffset(text, text.length))).toBe(text.length)
    expect(bufferOffset('a😀b', 4)).toBe(4)
    expect(indexForBufferOffset('a😀b', 4)).toBe(4)
    expect(indexForBufferOffset('', 0)).toBe(0)
    expect(indexForBufferOffset('ab', 99)).toBe(2)
  })
})
