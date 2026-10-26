import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { create, importNotes, list, markSent, queue, queued, read, remove, revokeBinding, share, unshare, update, visibleTo, type NoteInput } from './store'

const root = () => mkdtempSync(join(tmpdir(), 'harness-notes-'))
const page: NoteInput = { source: { url: 'https://example.com/page', title: 'Page', capturedAt: '2026-10-23T00:00:00Z' }, target: { kind: 'page' }, body: '  private body  ', tags: [' tag ', 'tag'] }

describe('page note store', () => {
  it('creates, reads, lists, updates with the version last seen, and deletes', () => {
    const dir = root()
    const note = create(dir, page)
    expect(note).toMatchObject({ version: 1, body: 'private body', tags: ['tag'], status: 'open', author: 'user', grants: [] })
    expect(read(dir, note.id)).toEqual(note)
    expect(list(dir).notes).toEqual([note])
    const target = { kind: 'text' as const, exact: '😀é', prefix: '', suffix: '', start: 2, end: 5 }
    const updated = update(dir, note.id, 1, { body: 'replacement', status: 'resolved', target })
    expect(updated).toMatchObject({ version: 2, body: 'replacement', status: 'resolved', target })
    expect(updated.history.map((entry) => entry.operation)).toEqual(['create', 'update'])
    expect(() => update(dir, note.id, 1, { body: 'stale' })).toThrow(expect.objectContaining({ code: 'version_conflict' }))
    expect(() => remove(dir, note.id, 1)).toThrow(expect.objectContaining({ code: 'version_conflict' }))
    remove(dir, note.id, 2)
    expect(list(dir).notes).toEqual([])
    expect(() => read(dir, note.id)).toThrow(expect.objectContaining({ code: 'not_found' }))
  })

  it('refuses addresses with credentials, bad offsets, empty element evidence and stray fields', () => {
    const dir = root()
    for (const url of ['ftp://example.com/', 'https://user:pw@example.com/', 'https://@example.com/', 'https://exa mple.com/']) {
      expect(() => create(dir, { ...page, source: { ...page.source, url } })).toThrow()
    }
    expect(() => create(dir, { ...page, target: { kind: 'text', exact: 'abc', prefix: '', suffix: '', start: 0, end: 4 } })).toThrow('offsets')
    expect(() => create(dir, { ...page, target: { kind: 'element', tag: 'button', role: '', name: ' ', text: '', context: '', selector: 'button' } })).toThrow('meaningful')
    expect(() => create(dir, { ...page, target: { kind: 'page', extra: 1 } as never })).toThrow()
    expect(() => create(dir, { ...page, body: '   ' })).toThrow()
    expect(() => create(dir, { ...page, tags: Array.from({ length: 13 }, (_, index) => `t${index}`) })).toThrow('12 tags')
  })

  it('accepts an otherwise empty element only when its CSS selector is specific', () => {
    const dir = root()
    const target = { kind: 'element' as const, tag: 'div', role: '', name: '', text: '', context: '', selector: 'main > div.empty-space:nth-of-type(2)' }
    expect(create(dir, { ...page, target }).target).toEqual(target)
    expect(() => create(dir, { ...page, target: { ...target, selector: 'div' } })).toThrow('specific selector')
  })

  it('keeps the composed-tree marker on text and element targets, and only that value', () => {
    const dir = root()
    const text = { kind: 'text' as const, exact: 'quick fox', prefix: 'The ', suffix: '', start: 4, end: 13, tree: 'composed' as const }
    const element = { kind: 'element' as const, tag: 'button', role: 'button', name: 'Share', text: 'Share', context: 'Body', selector: 'button', tree: 'composed' as const }
    expect(create(dir, { ...page, target: text }).target).toEqual(text)
    expect(create(dir, { ...page, target: element }).target).toEqual(element)
    // A target without it is a document-only target and stays that way.
    const { tree: _tree, ...legacy } = element
    expect(create(dir, { ...page, target: legacy }).target).toEqual(legacy)
    expect(() => create(dir, { ...page, target: { ...text, tree: 'flat' } as never })).toThrow('tree')
    expect(() => create(dir, { ...page, target: { kind: 'page', tree: 'composed' } as never })).toThrow()
  })

  it('is private until shared with a session or an agent, and a binding revokes its grants', () => {
    const dir = root()
    const note = create(dir, page)
    expect(visibleTo(note, { sessionId: 's1' })).toBe(false)
    const forSession = share(dir, note.id, { sessionId: 's1' })
    expect(visibleTo(forSession, { sessionId: 's1' })).toBe(true)
    expect(visibleTo(forSession, { sessionId: 's2' })).toBe(false)
    const forAgent = share(dir, note.id, { agentId: 'agent-1' }, 'tab:t1@3')
    expect(visibleTo(forAgent, { agentId: 'agent-1' })).toBe(true)
    expect(() => share(dir, note.id, { sessionId: 's1', agentId: 'a' })).toThrow('exactly one')
    expect(revokeBinding(dir, 'tab:t1@3')).toBe(1)
    expect(visibleTo(read(dir, note.id), { agentId: 'agent-1' })).toBe(false)
    expect(visibleTo(read(dir, note.id), { sessionId: 's1' })).toBe(true)
    expect(visibleTo(unshare(dir, note.id, { sessionId: 's1' }), { sessionId: 's1' })).toBe(false)
  })

  it('keeps resolved notes out of delivery and requires confirmation once page-origin delivery is flagged', () => {
    const dir = root()
    const note = create(dir, page)
    const pending = queue(dir, note.id, note.version, 's1', { confirm: true })
    const stillPending = queue(dir, note.id, pending.version, 's1')
    expect(stillPending.delivery?.confirm).toBe(true)
    expect(queued(dir, 's1').map((entry) => entry.id)).toEqual([note.id])
    expect(() => markSent(dir, [note.id], 's1', 'run-1')).toThrow('Confirm this note')

    const confirmed = queue(dir, note.id, stillPending.version, 's1', { confirmed: true })
    expect(confirmed.delivery?.confirm).toBeUndefined()
    expect(markSent(dir, [note.id], 's1', 'run-1')[0].delivery).toMatchObject({ state: 'sent', runId: 'run-1' })

    const another = create(dir, page)
    const queuedNote = queue(dir, another.id, another.version, 's1')
    const resolved = update(dir, another.id, queuedNote.version, { status: 'resolved' })
    expect(resolved.delivery).toBeNull()
    expect(queued(dir, 's1').map((entry) => entry.id)).not.toContain(another.id)
    expect(() => queue(dir, another.id, resolved.version, 's1')).toThrow('Reopen this note')
    expect(() => markSent(dir, [another.id], 's1', 'run-2')).toThrow('Resolved notes')
  })

  it('searches and filters by page and status', () => {
    const dir = root()
    create(dir, { ...page, body: 'about the login form' })
    const other = create(dir, { ...page, source: { ...page.source, url: 'https://example.com/other' }, body: 'pricing table' })
    update(dir, other.id, 1, { status: 'resolved' })
    expect(list(dir, { query: 'LOGIN' }).notes.map((note) => note.body)).toEqual(['about the login form'])
    expect(list(dir, { url: 'https://example.com/other' }).total).toBe(1)
    expect(list(dir, { status: 'resolved' }).notes[0].id).toBe(other.id)
  })

  it('imports notes another store kept, keeping their ids, and skips what exists or is invalid', () => {
    const dir = root()
    const result = importNotes(dir, [
      { id: 'kept-1', source: page.source, target: { kind: 'page' }, body: 'old note', tags: ['x'], status: 'resolved', grants: [{ principal: { agentId: 'solo-assistant' }, binding: 'tab:t2@1' }] },
      { id: 'kept-1', source: page.source, target: { kind: 'page' }, body: 'again' },
      { id: '../bad', source: page.source, target: { kind: 'page' }, body: 'x' }
    ])
    expect(result.imported).toEqual(['kept-1'])
    expect(result.skipped.map((entry) => entry.reason)).toEqual(['exists', 'Invalid identifier.'])
    expect(read(dir, 'kept-1')).toMatchObject({ status: 'resolved', history: [{ operation: 'import' }] })
    expect(visibleTo(read(dir, 'kept-1'), { agentId: 'solo-assistant' })).toBe(true)
  })

  it('skips a damaged file instead of listing it', () => {
    const dir = root()
    const note = create(dir, page)
    writeFileSync(join(dir, 'annotations', 'broken.json'), '{"id":"other"}')
    expect(list(dir).notes.map((entry) => entry.id)).toEqual([note.id])
    expect(readFileSync(join(dir, 'annotations', `${note.id}.json`), 'utf8')).toContain('"kind": "page"')
  })
})
