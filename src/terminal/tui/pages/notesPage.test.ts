import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import type { Note } from '../../../annotations/store'
import { createHarnessTheme } from '../theme'
import { NOTE_ACTIONS, NOTE_KINDS, NotesPage } from './notesPage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)

const note = (id: string, extra: Partial<Note> = {}): Note => ({
  id, version: 1, source: { url: 'https://example.com/a', title: 'Example', capturedAt: '' }, target: { kind: 'text', exact: 'quick brown', prefix: '', suffix: '', start: 4, end: 15 },
  body: `Body of ${id}`, tags: [], status: 'open', author: 'user', createdAt: '', updatedAt: '', grants: [], history: [], ...extra
})

function setup(notes: Note[], answers: { select?: string[]; confirm?: boolean[]; input?: string[] } = {}) {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const selects = [...(answers.select ?? [])]
  const confirms = [...(answers.confirm ?? [])]
  const inputs = [...(answers.input ?? [])]
  const options = {
    theme: () => theme,
    call: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'terminal.annotations.list') return { notes, total: notes.length, sessionId: 's1' }
      if (method === 'terminal.annotations.begin') return { captureId: 'c1' }
      if (method === 'terminal.annotations.capture') return { url: 'https://example.com/a', title: 'Example', documentId: 'd1', target: { kind: 'text', exact: 'quick', prefix: '', suffix: '', start: 0, end: 5 } }
      if (method === 'terminal.annotations.identity') return { url: 'https://example.com/a', title: 'Example', documentId: 'd1' }
      if (method === 'terminal.annotations.reveal') return { state: 'matched' }
      return {}
    }) as never,
    ui: {
      select: vi.fn(async () => selects.shift()),
      confirm: vi.fn(async () => confirms.shift() ?? false),
      notify: vi.fn(),
      input: vi.fn(async () => inputs.shift())
    },
    changed: vi.fn()
  }
  const page = new NotesPage(options)
  page.focused = true
  return { page, options, calls }
}

describe('the Page notes page', () => {
  it('lists notes with what they point at and whether this session can read them', async () => {
    const { page } = setup([note('n1', { grants: [{ principal: { sessionId: 's1' }, grantedAt: '' }] }), note('n2', { status: 'resolved', target: { kind: 'page' } })])
    page.activate()
    await vi.waitFor(() => expect(page.rows()).toHaveLength(3))
    const text = page.render(110, 20).map(stripTerminalSequences).join('\n')
    expect(text).toContain('New note on a page')
    expect(text).toContain('“quick brown” · open · shared here')
    expect(text).toContain('whole page · resolved')
  })

  it('captures selected text in the window, saves the note and shares it with this session', async () => {
    const { page, calls } = setup([], { select: [NOTE_KINDS.text], confirm: [true, true], input: ['https://example.com/a', 'Remember this', 'ux, copy'] })
    page.activate()
    await vi.waitFor(() => expect(page.rows()).toHaveLength(1))
    await page.newNote()
    const methods = calls.map(call => call.method)
    expect(methods).toEqual(expect.arrayContaining(['terminal.annotations.open', 'terminal.annotations.begin', 'terminal.annotations.capture', 'terminal.annotations.create']))
    expect(calls.find(call => call.method === 'terminal.annotations.create')?.params).toMatchObject({
      body: 'Remember this', tags: ['ux', 'copy'], share: true,
      source: { url: 'https://example.com/a', surface: 'terminal', representationHint: 'd1' },
      target: { kind: 'text', exact: 'quick' }
    })
  })

  it('cancels a capture the person does not confirm, and saves nothing', async () => {
    const { page, calls } = setup([], { select: [NOTE_KINDS.element], confirm: [false], input: ['https://example.com/a'] })
    page.activate()
    await vi.waitFor(() => expect(page.rows()).toHaveLength(1))
    await page.newNote()
    expect(calls.map(call => call.method)).toContain('terminal.annotations.cancel')
    expect(calls.map(call => call.method)).not.toContain('terminal.annotations.create')
  })

  it('reveals, resolves with the version it read, and shares a note', async () => {
    const existing = note('n1')
    const { page, calls } = setup([existing], { select: [NOTE_ACTIONS.reveal, NOTE_ACTIONS.resolve, NOTE_ACTIONS.share] })
    page.activate()
    await vi.waitFor(() => expect(page.rows()).toHaveLength(2))
    for (let index = 0; index < 3; index += 1) await page.activateRow({ kind: 'note', note: existing })
    expect(calls.find(call => call.method === 'terminal.annotations.reveal')?.params).toEqual({ id: 'n1' })
    expect(calls.find(call => call.method === 'terminal.annotations.update')?.params).toEqual({ id: 'n1', expectedVersion: 1, patch: { status: 'resolved' } })
    expect(calls.find(call => call.method === 'terminal.annotations.share')?.params).toEqual({ id: 'n1' })
  })
})
