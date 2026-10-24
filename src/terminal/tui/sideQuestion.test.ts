import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth, type Component } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import type { RunEvent, RunRecord } from '../../sessions/contracts'
import type { SideQuestionContext, SideQuestionRead } from '../../sessions/sideQuestions'
import { SideQuestion, sideQuestionSnapshot } from './sideQuestion'
import { neutralRule } from './chrome'
import { createHarnessTheme } from './theme'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (content: unknown) => ({ role: 'assistant', content })

function event(sequence: number, type: RunEvent['type'], payload: unknown): RunEvent {
  return { id: `event-${sequence}`, runId: 'side-run', sessionId: 'side-session', sequence, timestamp: '2026-10-24T00:00:00.000Z', type, payload }
}

function result(status: string, events: RunEvent[] = []): SideQuestionRead {
  return {
    run: { id: 'side-run', sessionId: 'side-session', trigger: 'side-question', status, terminalReason: null } as RunRecord,
    events
  }
}

function setup(script: {
  reads?: (runId: string, afterSequence: number) => Promise<SideQuestionRead>
  starts?: (question: string, context: SideQuestionContext) => Promise<{ runId: string; sessionId: string; nativeSessionId: string | null }>
} = {}) {
  let docked: Component | undefined
  const mount = vi.fn((dock: Component | undefined) => { docked = dock })
  const changed = vi.fn()
  const start = vi.fn(script.starts ?? (async () => ({ runId: 'side-run', sessionId: 'side-session', nativeSessionId: 'native-side' })))
  const read = vi.fn(script.reads ?? (async () => result('running')))
  const interrupt = vi.fn(async () => ({}))
  const copyText = vi.fn(async () => undefined)
  const context = vi.fn(() => ({ instructions: 'Use project conventions.', transcript: 'Assistant: reading the config.' }))
  const side = new SideQuestion({ context, start, read, interrupt, copyText, theme: () => theme, mount, changed })
  return {
    side, mount, changed, start, read, interrupt, copyText, context,
    dock: () => docked,
    rows: (width = 80) => (docked?.render(width) ?? []).map(stripTerminalSequences)
  }
}

describe('the side question context', () => {
  it('includes visible history, tool inputs and results, while omitting hidden reasoning and image bytes', () => {
    const text = sideQuestionSnapshot([
      user('Fix the failing test'),
      assistant([{ type: 'thinking', thinking: 'secret reasoning' }, { type: 'text', text: 'Looking at it.' }, { type: 'toolCall', name: 'read', arguments: { path: '/tmp/config.json' } }]),
      { role: 'toolResult', toolName: 'read', toolCallId: 'call-1', content: [{ type: 'text', text: 'The setting is false.' }, { type: 'image', data: 'image-secret' }] },
      user('Will that change the rollout?'),
      assistant('The current setting blocks it.')
    ], false)

    expect(text).toContain('User:\nFix the failing test')
    expect(text).toContain('Assistant tool call (read):\n{"path":"/tmp/config.json"}')
    expect(text).toContain('Tool result (read, call-1):\nThe setting is false.')
    expect(text).toContain('The current setting blocks it.')
    for (const hidden of ['secret reasoning', 'image-secret']) expect(text).not.toContain(hidden)
    expect(text).not.toContain('still running')
  })

  it('keeps much more than the old six-turn, 6,000-character excerpt and marks any trimmed history', () => {
    const turns = Array.from({ length: 40 }, (_, index) => index % 2
      ? assistant([{ type: 'text', text: `answer ${index} ${'x'.repeat(2_000)}` }])
      : user(`question ${index} ${'y'.repeat(2_000)}`))
    const text = sideQuestionSnapshot(turns, true)
    expect(text.length).toBeGreaterThan(6_000)
    expect(text).toContain('answer 39')
    expect(text).toContain('question 0')
    expect(text).toContain('main reply is still running')
  })

  it('removes terminal control sequences from visible text', () => {
    expect(sideQuestionSnapshot([user('hello\x1b[31m red\x07\x1b]0;title\x07')], false)).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/)
  })
})

describe('the side question dock', () => {
  it('starts a separate run with the visible context and displays its streamed answer', async () => {
    let poll = 0
    const { side, mount, start, read, context, dock, rows } = setup({
      reads: async (_runId, after) => {
        poll++
        if (poll === 1) return result('running', [event(0, 'message.delta', { messageId: 'answer', text: 'It changes the rollout.' })])
        expect(after).toBe(0)
        return result('completed', [event(1, 'message.completed', { messageId: 'answer', role: 'assistant', text: 'It changes the rollout.' }), event(2, 'completed', {})])
      }
    })
    await side.ask('what does the setting change?')
    await vi.waitFor(() => expect(side.state).toBe('answered'))

    expect(start).toHaveBeenCalledWith('what does the setting change?', context())
    expect(read).toHaveBeenCalled()
    expect(mount).toHaveBeenCalledWith(expect.anything())
    expect(dock()?.render(80)?.[0]).toBe(neutralRule(80, theme))
    expect(rows().join('\n')).toContain('/btw what does the setting change?')
    expect(rows().join('\n')).toContain('It changes the rollout.')
    expect(rows().at(-1)).toContain('Ctrl+X copy')
  })

  it('replaces an earlier question by interrupting its run', async () => {
    const { side, interrupt, rows } = setup()
    await side.ask('first question')
    await vi.waitFor(() => expect(interrupt).not.toHaveBeenCalled())
    await side.ask('second question')
    expect(interrupt).toHaveBeenCalledWith('side-run')
    expect(rows().join('\n')).toContain('/btw second question')
    await side.dismiss()
  })

  it('dismisses and interrupts a running run; an empty question dismisses too', async () => {
    const { side, mount, interrupt, dock } = setup()
    await side.ask('one')
    await side.dismiss()
    expect(side.visible).toBe(false)
    expect(dock()).toBeUndefined()
    expect(mount).toHaveBeenLastCalledWith(undefined)
    expect(interrupt).toHaveBeenCalledWith('side-run')

    await side.ask('two')
    await side.ask('   ')
    expect(side.visible).toBe(false)
    expect(interrupt).toHaveBeenCalledTimes(2)
  })

  it('ignores a delayed start after dismissal and reports start failures', async () => {
    let finish: ((value: { runId: string; sessionId: string; nativeSessionId: string | null }) => void) | undefined
    const late = setup({ starts: () => new Promise(resolve => { finish = resolve }) })
    const asking = late.side.ask('late')
    await late.side.dismiss()
    finish?.({ runId: 'late-run', sessionId: 'side-session', nativeSessionId: null })
    await asking
    expect(late.interrupt).toHaveBeenCalledWith('late-run')
    expect(late.side.visible).toBe(false)

    const failed = setup({ starts: async () => { throw new Error('No model is selected.') } })
    await failed.side.ask('hi')
    expect(failed.side.state).toBe('failed')
    expect(failed.rows().join('\n')).toContain('No model is selected.')
  })

  it('scrolls and copies the complete answer, keeping every rendered row within width', async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n')
    const { side, rows, dock, copyText } = setup({ reads: async () => result('completed', [event(0, 'message.completed', { messageId: 'a', role: 'assistant', text: lines }), event(1, 'completed', {})]) })
    await side.ask('show me the full answer')
    await vi.waitFor(() => expect(side.state).toBe('answered'))
    expect(rows().join('\n')).toContain('line 0')
    side.scroll('down')
    expect(rows().join('\n')).toContain('line 6')
    await side.copyAnswer()
    expect(copyText).toHaveBeenCalledWith(lines)
    for (let width = 0; width <= 100; width++) for (const row of dock()!.render(width)) expect(visibleWidth(row), `width ${width}`).toBeLessThanOrEqual(width)
  })
})
