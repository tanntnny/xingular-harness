import { describe, expect, it } from 'vitest'

import { syncSlashCommandMark, type MarkTarget } from './composerMarks'

describe('composer slash command marks', () => {
  it('marks only the recognized command token and removes stale marks', () => {
    let text = '　/help argument'
    let nextId = 1
    const marks = new Map<number, { id: number; start: number; end: number; typeId?: number }>()
    const target: MarkTarget = {
      get plainText() { return text },
      extmarks: {
        create: options => {
          const id = nextId++
          marks.set(id, { id, start: options.start, end: options.end, typeId: options.typeId })
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

    syncSlashCommandMark(target, ['help'], 3, 7)
    expect([...marks.values()]).toEqual([{ id: 1, start: 2, end: 7, typeId: 3 }])

    syncSlashCommandMark(target, ['help'], 3, 7)
    expect(marks.size).toBe(1)

    text = ' /unknown argument'
    syncSlashCommandMark(target, ['help'], 3, 7)
    expect(marks.size).toBe(0)
  })
})
