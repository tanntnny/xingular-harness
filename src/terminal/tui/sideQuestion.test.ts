import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth, type Component } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import { ANSWER_ROWS, SideQuestion, sideQuestionSnapshot, type SideSession } from './sideQuestion'
import { neutralRule } from './chrome'
import { createHarnessTheme } from './theme'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (content: unknown) => ({ role: 'assistant', content })

describe('the side question snapshot', () => {
  it('keeps recent user and assistant turns, names the tools an assistant turn called, and leaves out reasoning, tool results and images', () => {
    const text = sideQuestionSnapshot([
      user('Fix the failing test'),
      assistant([{ type: 'thinking', thinking: 'secret reasoning' }, { type: 'text', text: 'Looking at it.' }, { type: 'toolCall', name: 'read', arguments: { path: 'SECRET.md' } }]),
      { role: 'toolResult', content: [{ type: 'text', text: 'tool output body' }] },
      { role: 'user', content: [{ type: 'image', data: 'AAAA' }] },
      assistant('Done.')
    ], false)
    expect(text).toContain('User: Fix the failing test')
    expect(text).toContain('Assistant: Looking at it. [used tools: read]')
    expect(text).toContain('Assistant: Done.')
    for (const hidden of ['secret reasoning', 'SECRET.md', 'tool output body', 'AAAA']) expect(text).not.toContain(hidden)
    expect(text).not.toContain('still running')
  })

  it('is bounded in turns and in size, keeping the newest, and says when the reply is still running', () => {
    const turns = Array.from({ length: 40 }, (_, index) => index % 2 ? assistant([{ type: 'text', text: `answer ${index} ${'x'.repeat(2_000)}` }]) : user(`question ${index} ${'y'.repeat(2_000)}`))
    const text = sideQuestionSnapshot(turns, true)
    expect(text.length).toBeLessThan(7_500)
    expect(text).toContain('answer 39')
    expect(text).not.toContain('question 0 ')
    expect(text).toContain('The main reply is still running')
    expect(sideQuestionSnapshot([], false)).toContain('(nothing yet)')
  })

  it('removes terminal control sequences from what it forwards', () => {
    expect(sideQuestionSnapshot([user('hello\x1b[31m red\x07\x1b]0;title\x07')], false)).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/)
  })
})

function fakeSession(script: { answer?: string; delay?: Promise<void>; failure?: string; throws?: Error } = {}) {
  const listeners = new Set<() => void>()
  let answer = ''
  const state = { prompts: [] as string[], aborted: 0, disposed: 0 }
  const session: SideSession = {
    prompt: async text => {
      state.prompts.push(text)
      if (script.throws) throw script.throws
      answer = (script.answer ?? '').slice(0, 5)
      for (const listener of listeners) listener()
      await script.delay
      answer = script.answer ?? ''
      for (const listener of listeners) listener()
    },
    abort: async () => { state.aborted++ },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    answer: () => answer,
    failure: () => script.failure,
    dispose: () => { state.disposed++ }
  }
  return { session, state }
}

function setup(sessions: Array<ReturnType<typeof fakeSession>>) {
  let docked: Component | undefined
  const mount = vi.fn((dock: Component | undefined) => { docked = dock })
  const changed = vi.fn()
  const create = vi.fn(async () => sessions.shift()!.session)
  const side = new SideQuestion({ create, snapshot: () => 'Conversation excerpt, oldest first:\nUser: hi', theme: () => theme, mount, changed })
  return { side, mount, changed, create, dock: () => docked, rows: (width = 80) => (docked?.render(width) ?? []).map(stripTerminalSequences) }
}

describe('the side question', () => {
  it('shows a dock above the composer while it works, then the answer, without touching anything else', async () => {
    let release: () => void = () => {}
    const run = fakeSession({ answer: 'It renames the file.', delay: new Promise<void>(resolve => { release = resolve }) })
    const { side, mount, rows } = setup([run])
    const asking = side.ask('what does the second step do?')
    await vi.waitFor(() => expect(run.state.prompts).toHaveLength(1))
    expect(side.state).toBe('thinking')
    expect(mount).toHaveBeenCalledWith(expect.anything())
    expect(rows()[0]).toBe('─'.repeat(80))
    expect(rows()[1]).toMatch(/^ {2}[·✢✳✶✻✽] \/btw what does the second step do\?$/u)
    expect(rows()[2]).toBe('')
    expect(rows()[3]).toBe('  It re')
    expect(rows()[4]).toBe('')
    expect(rows().join('\n')).not.toMatch(/Thinking…|Answered|Failed/u)
    release()
    await asking
    expect(side.state).toBe('answered')
    expect(rows()[1]).toBe('  /btw what does the second step do?')
    expect(rows()[2]).toBe('')
    expect(rows()[3]).toBe('  It renames the file.')
    expect(rows()[4]).toBe('')
    expect(rows().at(-1)).toBe('  /btw or Esc to dismiss')
    expect(run.state.prompts[0]).toContain('Conversation excerpt, oldest first:')
    expect(run.state.prompts[0]).toContain('Side question: what does the second step do?')
  })

  it('uses the normal composer divider color for its top rule', async () => {
    const { side, dock } = setup([fakeSession({ answer: 'ok' })])
    await side.ask('hi')
    expect(dock()?.render(80)?.[0]).toBe(neutralRule(80, theme))
    await side.dismiss()
  })

  it('has no closing rule of its own, because the composer\'s rule closes it', async () => {
    const { side, rows } = setup([fakeSession({ answer: 'ok' })])
    await side.ask('hi')
    expect(rows().filter(row => /^─+$/.test(row))).toHaveLength(1)
    expect(rows().join('\n')).not.toMatch(/[╭╮╰╯│├┤]/)
  })

  it('replaces an earlier question, interrupting and releasing its session', async () => {
    const first = fakeSession({ answer: 'first', delay: new Promise<void>(() => {}) })
    const second = fakeSession({ answer: 'second' })
    const { side, rows } = setup([first, second])
    void side.ask('one')
    await vi.waitFor(() => expect(first.state.prompts).toHaveLength(1))
    await side.ask('two')
    expect(first.state.aborted).toBe(1)
    expect(first.state.disposed).toBe(1)
    expect(rows().join('\n')).toContain('/btw two')
    expect(rows().join('\n')).toContain('second')
    expect(rows().join('\n')).not.toContain('first')
  })

  it('dismisses by removing the dock and interrupting the run, and an empty question dismisses too', async () => {
    const run = fakeSession({ answer: 'x', delay: new Promise<void>(() => {}) })
    const { side, mount, dock } = setup([run])
    void side.ask('one')
    await vi.waitFor(() => expect(run.state.prompts).toHaveLength(1))
    expect(side.visible).toBe(true)
    await side.ask('   ')
    expect(side.visible).toBe(false)
    expect(dock()).toBeUndefined()
    expect(mount).toHaveBeenLastCalledWith(undefined)
    expect(run.state.aborted).toBe(1)
    expect(run.state.disposed).toBe(1)
  })

  it('ignores a session that finishes after it was replaced or dismissed', async () => {
    let finish: () => void = () => {}
    const late = fakeSession({ answer: 'late answer', delay: new Promise<void>(resolve => { finish = resolve }) })
    const { side, rows } = setup([late])
    const asking = side.ask('one')
    await vi.waitFor(() => expect(late.state.prompts).toHaveLength(1))
    await side.dismiss()
    finish()
    await asking
    expect(side.visible).toBe(false)
    expect(rows()).toEqual([])
  })

  it('discards a session that was created after the question was already replaced', async () => {
    let made: (session: SideSession) => void = () => {}
    const slow = new Promise<SideSession>(resolve => { made = resolve })
    const quick = fakeSession({ answer: 'quick' })
    const sessions = [slow, Promise.resolve(quick.session)]
    const side = new SideQuestion({ create: () => sessions.shift()!, snapshot: () => '', theme: () => theme, mount: () => {}, changed: () => {} })
    const first = side.ask('one')
    const second = side.ask('two')
    const late = fakeSession({ answer: 'late' })
    made(late.session)
    await Promise.all([first, second])
    expect(late.state.disposed).toBe(1)
    expect(late.state.prompts).toHaveLength(0)
    expect(side.state).toBe('answered')
  })

  it('shows a failure in the dock: a thrown error, an error the provider ended the turn with, or no model', async () => {
    const thrown = setup([fakeSession({ throws: new Error('No account is signed in') })])
    await thrown.side.ask('hi')
    expect(thrown.side.state).toBe('failed')
    expect(thrown.rows()[1]).toBe('  /btw hi')
    expect(thrown.rows()[2]).toBe('')
    expect(thrown.rows().join('\n')).toContain('No account is signed in')
    expect(thrown.rows().join('\n')).not.toContain('Failed')

    const ended = setup([fakeSession({ answer: '', failure: 'Rate limit reached' })])
    await ended.side.ask('hi')
    expect(ended.side.state).toBe('failed')
    expect(ended.rows()[1]).toBe('  /btw hi')
    expect(ended.rows().join('\n')).toContain('Rate limit reached')
    expect(ended.rows().join('\n')).not.toContain('Failed')

    const none = new SideQuestion({ create: async () => { throw new Error('Choose a model before asking a side question.') }, snapshot: () => '', theme: () => theme, mount: () => {}, changed: () => {} })
    await none.ask('hi')
    expect(none.state).toBe('failed')
  })

  it('shows only the first rows of a long answer and says how many are hidden, never past the width', async () => {
    const long = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n')
    const { side, rows, dock } = setup([fakeSession({ answer: long })])
    await side.ask('a very long question '.repeat(20))
    const shown = rows()
    expect(shown.join('\n')).toContain('line 0')
    expect(shown.join('\n')).toContain(`line ${ANSWER_ROWS - 1}`)
    expect(shown.join('\n')).not.toContain(`line ${ANSWER_ROWS}\n`)
    expect(shown.at(-1)).toContain(`+${30 - ANSWER_ROWS} more lines`)
    expect(shown.some(row => row.includes('/btw a very long question'))).toBe(true)
    expect(shown.some(row => /^ {7}/u.test(row))).toBe(true)
    for (let width = 0; width <= 100; width++) for (const row of dock()!.render(width)) expect(visibleWidth(row), `width ${width}`).toBeLessThanOrEqual(width)
  })
})
