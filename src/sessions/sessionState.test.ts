import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { sessionStateText } from '../prompt/compile'
import { latestSessionName } from './sessionState'

describe('session state', () => {
  it('shows the name, this run\'s empty todo, and the previous list as context', () => {
    const text = sessionStateText({
      name: 'Fix login',
      todo: [],
      previousTodo: [{ text: 'Read the code', status: 'completed' }],
      firstTurn: false
    }, { name: true, todo: true })!
    expect(text).toContain('Name: "Fix login".')
    expect(text).toContain('Todo for this run: The todo list is empty.')
    expect(text).toContain("Previous run's todo (context, not this run's list):")
    expect(text).toContain('[x] Read the code')
    expect(text).toContain('continues the conversation; the todo list resets for each run')
  })

  it('omits a line for a tool the run does not have', () => {
    expect(sessionStateText({ name: null, todo: [], firstTurn: true }, { name: true, todo: false })).toBe('Name: unnamed.\nThis is the first turn in this native session.')
    expect(sessionStateText({ name: 'Fix login', todo: [], firstTurn: true }, { name: false, todo: true })).toContain('Todo for this run')
    expect(sessionStateText({ name: 'Fix login', todo: [], firstTurn: true }, { name: false, todo: false })).toBeNull()
  })

  it('reads the latest session_info name and treats a cleared name as absent', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'harness-session-state-')), 'chat.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'session_info', name: 'First name' }),
      JSON.stringify({ type: 'message', id: 'm1' }),
      JSON.stringify({ type: 'session_info', name: '  Latest name  ' })
    ].join('\n'))
    expect(latestSessionName(file)).toBe('Latest name')
    writeFileSync(file, `${JSON.stringify({ type: 'session_info', name: 'Latest name' })}\n${JSON.stringify({ type: 'session_info', name: '  ' })}\n`)
    expect(latestSessionName(file)).toBeNull()
  })

  it('returns null for missing or malformed history', () => {
    expect(latestSessionName(null)).toBeNull()
    expect(latestSessionName('/no/such/session.jsonl')).toBeNull()
    const file = join(mkdtempSync(join(tmpdir(), 'harness-session-state-')), 'chat.jsonl')
    writeFileSync(file, 'not json\n{"type":"session","id":"s"}\n')
    expect(latestSessionName(file)).toBeNull()
  })
})
