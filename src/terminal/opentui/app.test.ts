import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyToClipboard } from '@earendil-works/pi-coding-agent'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'

vi.mock('@earendil-works/pi-coding-agent', async importOriginal => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>()
  return { ...actual, copyToClipboard: vi.fn(async (_text: string) => {}) }
})

import { OpenTuiApplication, type KeyInput } from './app'
import { TranscriptModel } from './model'
import { QuestionDockState, type QuestionDockQuestion } from './questionDockState'
import { workingLineText } from './workingLine'
import type { TerminalDecision, TerminalRuntime } from '../tui/runtime'

function question(requestId: string, overrides: Partial<TerminalDecision> = {}): TerminalDecision {
  return {
    type: 'question',
    requestId,
    question: `Question ${requestId}?`,
    summary: `Question ${requestId}`,
    options: [{ label: 'Default choice', description: 'Default choice description.', recommended: true }],
    allowText: true,
    ...overrides
  }
}

function key(name: string, sequence: string, shift = false): KeyInput {
  return { name, sequence, ctrl: false, meta: false, shift, option: false }
}

describe('OpenTuiApplication', () => {
  it('puts temporary status text in the transcript instead of beside the working line', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as { notify(message: string, type?: string): void }
    internals.notify('Plan request queued as an isolated run.')

    expect(app.view().items.at(-1)).toMatchObject({
      kind: 'notice', text: 'Plan request queued as an isolated run.'
    })
    expect(app.view().working.label).toBe('')
    expect(app.view().working).not.toHaveProperty('notification')
    expect(app.view()).not.toHaveProperty('queue')
    await app.shutdown()
  })

  it('keeps the welcome for one-line notices and hides it for multiline output', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as { notify(message: string, type?: string): void }

    internals.notify('Starting session…')
    expect(app.view().home).toBe(true)

    internals.notify('/help  List the commands\n/quit  Restore the terminal and exit')
    expect(app.view().home).toBe(false)
    await app.shutdown()
  })

  it('exposes cache-read tokens and includes them in the input total', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as { runtime?: TerminalRuntime }
    internals.runtime = {
      session: {
        messages: [], state: {},
        getSessionStats: () => ({ tokens: { input: 200, cacheRead: 800, output: 40 } })
      },
      snapshot: () => undefined,
      dispose: async () => {}
    } as unknown as TerminalRuntime

    expect(app.view()).toMatchObject({ inputTokens: 1000, cacheReadTokens: 800, outputTokens: 40 })
    await app.shutdown()
  })

  it('surfaces the persisted compaction summary when compaction completes', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as { accept(event: AgentSessionEvent): void; runtime?: TerminalRuntime }
    internals.runtime = {
      session: { messages: [
        { role: 'user', content: 'hello' },
        { role: 'compactionSummary', summary: 'Earlier discussion and decisions.', tokensBefore: 12_345 }
      ], state: {} },
      snapshot: () => undefined,
      dispose: async () => {}
    } as unknown as TerminalRuntime

    internals.accept({ type: 'compaction_end', reason: 'threshold', result: { summary: 'Earlier discussion and decisions.', tokensBefore: 12_345 } } as AgentSessionEvent)

    expect(app.view().items.at(-1)).toMatchObject({
      kind: 'compaction', summary: 'Earlier discussion and decisions.', tokensBefore: 12_345
    })
    expect(app.view().items.filter(item => item.kind === 'compaction')).toHaveLength(1)
    await app.shutdown()
  })

  it('puts compaction failures into chat as error notices', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as { accept(event: AgentSessionEvent): void; runtime?: TerminalRuntime }
    internals.runtime = {
      session: { messages: [{ role: 'user', content: 'hello' }], state: {} },
      snapshot: () => undefined,
      dispose: async () => {}
    } as unknown as TerminalRuntime

    internals.accept({
      type: 'compaction_end', errorMessage: 'Turn prefix summarization failed: The operation was aborted.'
    } as AgentSessionEvent)

    expect(app.view().items.at(-1)).toMatchObject({
      kind: 'notice', level: 'error', text: 'Turn prefix summarization failed: The operation was aborted.'
    })
    expect(app.view().working.label).toBe('')
    await app.shutdown()
  })

  it('puts retry and compaction lifecycle updates in chat, not the working line', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as { accept(event: AgentSessionEvent): void; runtime?: TerminalRuntime }
    internals.runtime = {
      session: { messages: [{ role: 'user', content: 'hello' }], state: {} },
      snapshot: () => undefined,
      dispose: async () => {}
    } as unknown as TerminalRuntime

    internals.accept({ type: 'agent_start' } as AgentSessionEvent)
    const workingLabel = app.view().working.label
    internals.accept({
      type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1500, errorMessage: 'rate limited'
    } as AgentSessionEvent)
    expect(app.view().items.at(-1)).toMatchObject({
      kind: 'notice', level: 'warning', text: 'Retry 1/3 in 1.5s: rate limited'
    })

    internals.accept({ type: 'compaction_start', reason: 'threshold' } as AgentSessionEvent)
    expect(app.view().items.at(-1)).toMatchObject({ kind: 'notice', text: 'Compacting context…' })
    internals.accept({
      type: 'summarization_retry_scheduled', attempt: 2, maxAttempts: 4, delayMs: 2500, errorMessage: 'temporary failure'
    } as AgentSessionEvent)
    expect(app.view().items.at(-1)).toMatchObject({
      kind: 'notice', level: 'warning', text: 'Retry 2/4 in 2.5s: temporary failure'
    })
    internals.accept({
      type: 'summarization_retry_attempt_start', source: 'compaction', reason: 'threshold'
    } as AgentSessionEvent)
    expect(app.view().items.at(-1)).toMatchObject({ kind: 'notice', text: 'Retrying context compaction…' })
    internals.accept({ type: 'summarization_retry_attempt_start', source: 'branchSummary' } as AgentSessionEvent)
    expect(app.view().items.at(-1)).toMatchObject({ kind: 'notice', text: 'Retrying branch summary…' })
    internals.accept({ type: 'summarization_retry_finished' } as AgentSessionEvent)
    expect(app.view().items.at(-1)).toMatchObject({ kind: 'notice', text: 'Summarization retry finished.' })
    expect(app.view().working.label).toBe(workingLabel)
    await app.shutdown()
  })

  it('records deferred plan queue announcements in chat', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as { enqueuePlan(brief: string): void; runtime?: TerminalRuntime }
    internals.runtime = {
      session: { isIdle: false, messages: [] },
      snapshot: () => undefined,
      dispose: async () => {}
    } as unknown as TerminalRuntime
    internals.enqueuePlan('review the terminal status presentation')

    expect(app.view().items.at(-1)).toMatchObject({
      kind: 'notice', text: 'Plan request queued to run by itself after the current response.'
    })
    expect(app.view()).not.toHaveProperty('queue')
    await app.shutdown()
  })

  it('keeps completed run metrics in the working row until a new run starts', async () => {
    vi.useFakeTimers()
    const app = new OpenTuiApplication([])
    const internals = app as unknown as {
      accept(event: AgentSessionEvent): void
      resetActiveWorkingStatus(): void
      working(): { active: boolean; elapsedMs: number | null; tokensPerSecond: number | null; label: string }
    }
    try {
      vi.setSystemTime(new Date(10_000))
      internals.accept({ type: 'agent_start' } as AgentSessionEvent)
      vi.advanceTimersByTime(500)
      internals.accept({ type: 'turn_start' } as AgentSessionEvent)
      vi.advanceTimersByTime(1000)
      internals.accept({ type: 'message_end', message: { role: 'assistant', usage: { output: 40 } } } as AgentSessionEvent)
      expect(internals.working()).toMatchObject({ active: true, elapsedMs: 1500, tokensPerSecond: 40 })

      vi.advanceTimersByTime(500)
      internals.accept({ type: 'turn_start' } as AgentSessionEvent)
      vi.advanceTimersByTime(2000)
      internals.accept({ type: 'message_end', message: { role: 'assistant', usage: { output: 60 } } } as AgentSessionEvent)
      expect(internals.working().tokensPerSecond).toBe(30)

      internals.accept({ type: 'agent_settled' } as AgentSessionEvent)
      expect(internals.working()).toMatchObject({ active: false, elapsedMs: 4000, tokensPerSecond: 30 })
      expect(internals.working().label).toMatch(/^✻ /u)
      expect(workingLineText(app.view().working)).toMatch(/^✻ .+ \(4s, 30 tok\/s\)$/u)
      expect(app.view().items).toHaveLength(0)
      vi.advanceTimersByTime(5000)
      internals.resetActiveWorkingStatus()
      expect(internals.working()).toMatchObject({ active: false, elapsedMs: 4000, tokensPerSecond: 30 })

      internals.accept({ type: 'agent_start' } as AgentSessionEvent)
      expect(internals.working()).toMatchObject({ active: true, elapsedMs: 0, tokensPerSecond: null })
      await app.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows successful transcript copies as a temporary toast, not a transcript notice', async () => {
    vi.useFakeTimers()
    const app = new OpenTuiApplication([])
    try {
      vi.mocked(copyToClipboard).mockClear()
      app.copySelection('selected transcript text')
      await Promise.resolve()
      await Promise.resolve()

      expect(copyToClipboard).toHaveBeenCalledWith('selected transcript text')
      expect(app.view().toast).toBe('Copied transcript selection')
      expect(app.view().items).toHaveLength(0)
      vi.advanceTimersByTime(2499)
      expect(app.view().toast).toBe('Copied transcript selection')
      vi.advanceTimersByTime(1)
      expect(app.view().toast).toBeNull()
    } finally {
      await app.shutdown()
      vi.useRealTimers()
    }
  })

  it('recalls active-session user prompts only from an empty composer', async () => {
    const app = new OpenTuiApplication([])
    const setThinkingLevel = vi.fn()
    const makeSession = (prompts: string[]) => ({
      messages: prompts.map(content => ({ role: 'user', content })),
      state: {},
      getAvailableThinkingLevels: () => ['off', 'medium', 'high'],
      supportsThinking: () => true,
      thinkingLevel: 'medium',
      setThinkingLevel,
      extensionRunner: { getShortcuts: () => new Map() }
    }) as unknown as AgentSession
    let activeSession = makeSession(['first prompt', 'second prompt', 'third prompt'])
    const runtime = {
      get session() { return activeSession },
      snapshot: () => undefined,
      dispose: async () => {}
    }
    const internals = app as unknown as {
      syncDraft(text: string): void
      clearDraft(): void
      resetPresentation(): void
      transcript: TranscriptModel
      runtime?: TerminalRuntime
      keybindings?: { matches(data: string, action: string): boolean; getResolvedBindings(): object }
    }
    internals.syncDraft = () => {}
    internals.runtime = runtime as unknown as TerminalRuntime
    internals.transcript.bind(activeSession)
    internals.keybindings = {
      matches: (data, action) => data === '\x1b[1;2A' && action === 'app.thinking.increase',
      getResolvedBindings: () => ({})
    }

    try {
      expect(app.handleKey(key('up', '\x1b[A'))).toBe(true)
      expect(app.view().draft).toBe('third prompt')
      expect(app.handleKey(key('up', '\x1b[A'))).toBe(false)
      expect(app.handleKey(key('down', '\x1b[B'))).toBe(false)
      expect(app.view().draft).toBe('third prompt')

      app.setDraft('unfinished draft')
      expect(app.handleKey(key('up', '\x1b[A'))).toBe(false)
      expect(app.view().draft).toBe('unfinished draft')

      expect(app.handleKey({ ...key('up', '\x1b[1;5A'), ctrl: true })).toBe(true)
      expect(app.view().draft).toBe('third prompt')
      expect(app.handleKey({ ...key('up', '\x1b[1;5A'), ctrl: true })).toBe(true)
      expect(app.view().draft).toBe('second prompt')
      expect(app.handleKey(key('up', '\x1b[1;2A', true))).toBe(true)
      expect(setThinkingLevel).toHaveBeenCalledWith('high')
      expect(app.view().draft).toBe('second prompt')
      internals.clearDraft()
      expect(app.handleKey(key('up', '\x1b[A'))).toBe(true)
      expect(app.view().draft).toBe('third prompt')

      app.setDraft('')
      activeSession = makeSession(['other first', 'other second', 'other third'])
      internals.resetPresentation()
      internals.transcript.bind(activeSession)
      expect(app.handleKey(key('up', '\x1b[A'))).toBe(true)
      expect(app.view().draft).toBe('other third')
    } finally {
      await app.shutdown()
    }
  })

  it('opens path completions on Tab and inserts the selected file without changing effort', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'harness-terminal-completion-'))
    const source = join(cwd, 'src')
    await mkdir(join(source, 'modules'), { recursive: true })
    await writeFile(join(source, 'main.ts'), '')
    await writeFile(join(source, 'map.ts'), '')
    const cycleThinkingLevel = vi.fn()
    const app = new OpenTuiApplication([])
    const internals = app as unknown as {
      runtime?: TerminalRuntime
      syncDraft(text: string): void
    }
    internals.runtime = {
      cwd,
      session: { cycleThinkingLevel, getSessionStats: () => ({ tokens: {} }) },
      snapshot: () => undefined,
      dispose: async () => {}
    } as unknown as TerminalRuntime
    internals.syncDraft = () => {}

    try {
      const draft = 'Inspect src/m and continue'
      const cursorOffset = draft.indexOf('src/m') + 'src/m'.length
      app.setDraft(draft)
      expect(app.handleKey({ ...key('tab', '\t'), cursorOffset })).toBe(true)
      await vi.waitFor(() => expect(app.view().fileCompletion?.items).toEqual([
        { path: 'src/modules/', directory: true },
        { path: 'src/main.ts', directory: false },
        { path: 'src/map.ts', directory: false }
      ]))
      expect(cycleThinkingLevel).not.toHaveBeenCalled()

      expect(app.handleKey(key('down', '\x1b[B'))).toBe(true)
      expect(app.view().fileCompletion?.index).toBe(1)
      expect(app.handleKey(key('enter', '\r'))).toBe(true)
      expect(app.view().draft).toBe('Inspect src/main.ts and continue')
      expect(app.view().draftCursorOffset).toBe('Inspect src/main.ts'.length)
      expect(app.view().fileCompletion).toBeNull()
      expect(cycleThinkingLevel).not.toHaveBeenCalled()

      const directoryDraft = 'Inspect src/mod'
      app.setDraft(directoryDraft)
      expect(app.handleKey({ ...key('tab', '\t'), cursorOffset: directoryDraft.length })).toBe(true)
      await vi.waitFor(() => expect(app.view().fileCompletion?.items).toEqual([
        { path: 'src/modules/', directory: true }
      ]))
      expect(app.handleKey(key('tab', '\t'))).toBe(true)
      expect(app.view().draft).toBe('Inspect src/modules/')
      expect(cycleThinkingLevel).not.toHaveBeenCalled()
    } finally {
      await app.shutdown()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('switches from plan mode to Bash when a leading exclamation is typed', async () => {
    const app = new OpenTuiApplication([])
    const setMode = vi.fn(async (_mode: 'normal' | 'plan') => {})
    const internals = app as unknown as {
      runtime?: TerminalRuntime
      syncDraft(text: string): void
      initialized: boolean
    }
    internals.runtime = {
      session: { getSessionStats: () => ({ tokens: {} }) },
      snapshot: () => undefined,
      setMode,
      dispose: async () => {}
    } as unknown as TerminalRuntime
    internals.syncDraft = () => {}

    try {
      expect(app.handleKey(key('tab', '\x1b[Z', true))).toBe(true)
      expect(app.view()).toMatchObject({ planMode: true, bashMode: false })

      expect(app.handleKey(key('!', '!'))).toBe(true)
      expect(app.view()).toMatchObject({ planMode: false, bashMode: true, draft: '' })
      app.setDraft('pwd')
      expect(app.view()).toMatchObject({ planMode: false, bashMode: true, draft: 'pwd' })
      expect(setMode).toHaveBeenNthCalledWith(1, 'plan')
      expect(setMode).toHaveBeenNthCalledWith(2, 'normal')
    } finally {
      await app.shutdown()
    }
  })

  it('switches Bash drafts to plan and back without losing text or overlapping modes', async () => {
    const app = new OpenTuiApplication([])
    const setMode = vi.fn(async (_mode: 'normal' | 'plan') => {})
    const internals = app as unknown as {
      runtime?: TerminalRuntime
      syncDraft(text: string): void
      initialized: boolean
    }
    internals.runtime = {
      session: { getSessionStats: () => ({ tokens: {} }) },
      snapshot: () => undefined,
      setMode,
      dispose: async () => {}
    } as unknown as TerminalRuntime
    internals.syncDraft = () => {}
    internals.initialized = true

    try {
      app.setDraft('!echo hello')
      expect(app.view()).toMatchObject({ planMode: false, bashMode: true, draft: 'echo hello' })

      app.handleKey(key('tab', '\x1b[Z', true))
      expect(app.view()).toMatchObject({ planMode: true, bashMode: false, draft: 'echo hello' })

      app.setDraftExternal('!pwd')
      expect(app.view()).toMatchObject({ planMode: false, bashMode: true, draft: 'pwd' })

      app.handleKey(key('tab', '\x1b[Z', true))
      expect(app.view()).toMatchObject({ planMode: true, bashMode: false, draft: 'pwd' })
      app.setDraft('/plan')
      app.submitPrompt()
      expect(app.view()).toMatchObject({ planMode: false, bashMode: false, draft: '' })
      expect(setMode).toHaveBeenNthCalledWith(1, 'plan')
      expect(setMode).toHaveBeenNthCalledWith(2, 'normal')
      expect(setMode).toHaveBeenNthCalledWith(3, 'plan')
      expect(setMode).toHaveBeenNthCalledWith(4, 'normal')
    } finally {
      await app.shutdown()
    }
  })

  it('attaches pasted images and large pastes as labels and sends them with the prompt', async () => {
    const app = new OpenTuiApplication([])
    const directory = await mkdtemp(join(tmpdir(), 'harness-attach-'))
    const png = join(directory, 'shot one.png')
    await writeFile(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
    const submit = vi.fn(async (_text: string, _followUp?: boolean, _images?: unknown[]) => {})
    const session = { model: { id: 'vision', name: 'Vision', input: ['text', 'image'] }, isIdle: true, getSessionStats: () => ({ tokens: {} }) }
    const internals = app as unknown as {
      runtime?: TerminalRuntime
      commands?: { expandSkill(text: string): string; execute(text: string): Promise<boolean> }
      syncDraft(text: string): void
      initialized: boolean
    }
    internals.runtime = { session, snapshot: () => undefined, submit, dispose: async () => {} } as unknown as TerminalRuntime
    internals.commands = { expandSkill: text => text, execute: async () => false }
    internals.syncDraft = () => {}
    internals.initialized = true
    const settle = () => vi.waitFor(() => expect(app.view().insertion).not.toBeNull())

    try {
      app.paste(png.replaceAll(' ', '\\ '))
      await settle()
      expect(app.view().insertion).toMatchObject({ epoch: 1, text: '[Image #1] ' })
      // The composer inserts the label and reports the draft back.
      app.setDraft('what is [Image #1] ')
      app.paste('a\nb\nc\nd\ne')
      await vi.waitFor(() => expect(app.view().insertion?.epoch).toBe(2))
      expect(app.view().insertion?.text).toBe('[Pasted text #2 +5 lines]')
      expect(app.view().attachments.map(item => item.label)).toEqual(['[Image #1]', '[Pasted text #2 +5 lines]'])
      app.setDraft('what is [Image #1] [Pasted text #2 +5 lines]')
      app.paste('short')
      await vi.waitFor(() => expect(app.view().insertion?.epoch).toBe(3))
      expect(app.view().insertion?.text).toBe('short')

      app.submitPrompt()
      await vi.waitFor(() => expect(submit).toHaveBeenCalled())
      const [text, followUp, images] = submit.mock.calls[0]!
      expect(text).toBe('what is [Image #1] a\nb\nc\nd\ne')
      expect(followUp).toBe(true)
      expect(images).toEqual([expect.objectContaining({ type: 'image', mimeType: expect.stringMatching(/^image\//u), data: expect.any(String) })])
      expect(app.view().attachments).toEqual([])
    } finally {
      await app.shutdown()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refuses images for a model without image input and forgets deleted labels', async () => {
    const app = new OpenTuiApplication([])
    const directory = await mkdtemp(join(tmpdir(), 'harness-attach-'))
    const png = join(directory, 'a.png')
    await writeFile(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
    const session = { model: { id: 'text-only', name: 'Text Only', input: ['text'] }, isIdle: true, getSessionStats: () => ({ tokens: {} }) }
    const internals = app as unknown as { runtime?: TerminalRuntime; syncDraft(text: string): void; transcript: TranscriptModel }
    internals.runtime = { session, snapshot: () => undefined, dispose: async () => {} } as unknown as TerminalRuntime
    internals.syncDraft = () => {}

    try {
      app.paste(png)
      await vi.waitFor(() => expect(app.view().items.some(item => item.kind === 'notice' && item.text.includes('does not accept images'))).toBe(true))
      expect(app.view().insertion).toBeNull()

      session.model.input = ['text', 'image']
      app.paste(png)
      await vi.waitFor(() => expect(app.view().attachments).toHaveLength(1))
      app.setDraft('[Image #1] ')
      app.setDraft(' ')
      expect(app.view().attachments).toEqual([])
    } finally {
      await app.shutdown()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps the transcript projection stable while typing into the composer', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as {
      transcript: TranscriptModel
      syncDraft(text: string): void
      accept(event: AgentSessionEvent): void
    }
    const messages = [
      { role: 'user', content: 'previous question' },
      { role: 'assistant', content: 'previous answer' }
    ]
    internals.transcript.bind({ messages, state: { pendingToolCalls: new Set() } } as unknown as AgentSession)
    internals.syncDraft = () => {}

    const initial = app.view()
    expect(initial.items).toHaveLength(2)
    let draft = ''
    for (const character of 'chat should remain stable while typing '.repeat(14)) {
      draft += character
      app.setDraft(draft)
      const next = app.view()
      expect(next.draft).toBe(draft)
      expect(next.items).toBe(initial.items)
    }

    messages.push({ role: 'assistant', content: 'next answer' })
    internals.accept({ type: 'message_end', message: { role: 'assistant' } } as AgentSessionEvent)
    expect(app.view().items).not.toBe(initial.items)
    expect(app.view().items).toHaveLength(3)

    await app.shutdown()
  })

  it('keeps a batch in an above-composer question dock until the full answer is submitted', async () => {
    const first = question('q1', {
      batchId: 'batch', batchIndex: 1, batchCount: 2,
      options: [{ label: 'A', description: 'Option A', recommended: true }, { label: 'B', description: 'Option B' }],
      multiSelect: true, allowText: true
    })
    const second = question('q2', { batchId: 'batch', batchIndex: 2, batchCount: 2 })
    const runtime = {
      pending: vi.fn(async () => [first, second]),
      answer: vi.fn(async () => {}),
      answerBatch: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      snapshot: vi.fn(() => undefined)
    }
    const app = new OpenTuiApplication([])
    const internals = app as unknown as {
      runtime?: TerminalRuntime
      decisions(): Promise<void>
      questionDock?: QuestionDockState
    }
    internals.runtime = runtime as unknown as TerminalRuntime

    const decision = internals.decisions()
    for (let index = 0; index < 5 && !app.view().questionDock; index += 1) await Promise.resolve()
    expect(app.view().questionDock).toMatchObject({ question: 'Question q1?', activeIndex: 0, count: 2 })

    expect(app.handleKey(key('tab', '\t'))).toBe(true)
    expect(app.view().questionDock?.focus).toBe('answer')
    expect(app.handleKey(key('tab', '\t'))).toBe(true)
    expect(app.view().questionDock?.focus).toBe('action')
    expect(app.handleKey(key('tab', '\t'))).toBe(true)
    expect(app.view().questionDock?.focus).toBe('composer')

    internals.questionDock!.toggleOption(1)
    app.activateQuestionAction()
    expect(app.view().questionDock).toMatchObject({ question: 'Question q2?', activeIndex: 1 })
    app.setQuestionText('A direct answer')
    app.activateQuestionAction()
    await decision

    expect(runtime.answerBatch).toHaveBeenCalledWith('batch', [
      { questionId: 'q1', answer: { selected: ['B'] } },
      { questionId: 'q2', answer: { selected: [], text: 'A direct answer' } }
    ])
    expect(runtime.answer).not.toHaveBeenCalled()
    expect(app.view().questionDock).toBeNull()

    internals.runtime = undefined
    await app.shutdown()
  })

  it('routes pointer hover and click actions through the command palette', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as {
      commands?: { completions(): { name: string; description?: string }[] }
      syncDraft(text: string): void
      submit(text: string): void
    }
    internals.commands = { completions: () => [
      { name: 'accounts', description: 'Manage accounts' },
      { name: 'settings', description: 'Configure settings' }
    ] }
    internals.syncDraft = () => {}
    const submit = vi.fn()
    internals.submit = submit

    app.setDraft('/')
    app.selectPaletteItem(1)
    expect(app.view().palette).toMatchObject({ index: 1 })
    expect(app.activatePaletteItem(1)).toBe(true)
    expect(submit).toHaveBeenCalledWith('/settings')
    expect(app.view().palette).toBeNull()

    await app.shutdown()
  })

  it('opens only safe Markdown links and exposes a hover affordance', async () => {
    const openLink = vi.fn(async (_url: string) => {})
    const setMousePointer = vi.fn()
    let target: string | null = 'https://example.test/docs'
    const app = new OpenTuiApplication([], openLink)
    app.attachRenderer({
      suspend: async () => {}, resume: async () => {}, setTitle: () => {}, destroy: () => {},
      getLinkAt: () => target, setMousePointer
    })

    app.updateLinkHover(12, 4)
    expect(app.view().linkHovered).toBe(true)
    expect(setMousePointer).toHaveBeenLastCalledWith('pointer')
    expect(app.activateLinkAt(12, 4)).toBe(true)
    await vi.waitFor(() => expect(openLink).toHaveBeenCalledWith('https://example.test/docs'))
    expect(app.view().linkHovered).toBe(false)

    target = 'javascript:alert(1)'
    app.updateLinkHover(12, 4)
    expect(app.view().linkHovered).toBe(false)
    expect(app.activateLinkAt(12, 4)).toBe(false)
    expect(openLink).toHaveBeenCalledOnce()
    await app.shutdown()
  })

  it('routes pointer hover and click actions through the plan choice', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as {
      planChoice: { show(title: string): void }
      editPlan(): void
    }
    internals.planChoice.show('Verified plan')
    const editPlan = vi.fn()
    internals.editPlan = editPlan

    app.selectPlanChoice(1)
    expect(app.view().planChoice).toMatchObject({ title: 'Verified plan', index: 1 })
    expect(app.activatePlanChoice(1)).toBe(true)
    expect(editPlan).toHaveBeenCalledOnce()

    await app.shutdown()
  })

  it('routes pointer focus and option clicks through the question dock state', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as { questionDock?: QuestionDockState; syncDraft(text: string): void }
    internals.syncDraft = () => {}
    internals.questionDock = new QuestionDockState([question('q1', {
      options: [{ label: 'First', recommended: true }, { label: 'Second' }], allowText: true
    }) as QuestionDockQuestion])

    app.focusQuestionOption(1)
    expect(app.view().questionDock).toMatchObject({ optionIndex: 1, focus: 'options' })
    app.activateQuestionOption(1)
    expect(app.view().questionDock).toMatchObject({ selected: ['Second'], focus: 'options' })
    expect(app.handleKey(key('tab', '\t'))).toBe(true)
    expect(app.view().questionDock).toMatchObject({
      focus: 'note',
      options: [
        { label: 'First', noteOpen: false },
        { label: 'Second', noteOpen: true, noteFocused: true }
      ]
    })
    app.setQuestionNote('Second', 'Context for this choice')
    expect(app.view().questionDock?.options[1]?.note).toBe('Context for this choice')
    app.focusQuestionAnswer()
    expect(app.view().questionDock?.focus).toBe('answer')
    app.focusQuestionComposer()
    expect(app.view().questionDock?.focus).toBe('composer')

    await app.shutdown()
  })

  it('answers a single question through terminal.answer', async () => {
    const pending = question('q1', { options: [{ label: 'Continue', recommended: true }] })
    const runtime = {
      pending: vi.fn(async () => [pending]),
      answer: vi.fn(async () => {}),
      answerBatch: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      snapshot: vi.fn(() => undefined)
    }
    const app = new OpenTuiApplication([])
    const internals = app as unknown as {
      runtime?: TerminalRuntime
      decisions(): Promise<void>
    }
    internals.runtime = runtime as unknown as TerminalRuntime

    const decision = internals.decisions()
    for (let index = 0; index < 5 && !app.view().questionDock; index += 1) await Promise.resolve()
    expect(app.handleKey(key('enter', '\r'))).toBe(true)
    expect(app.view().questionDock?.focus).toBe('options')
    expect(app.handleKey(key('enter', '\r'))).toBe(true)
    await decision

    expect(runtime.answer).toHaveBeenCalledWith('q1', { selected: ['Continue'] })
    expect(runtime.answerBatch).not.toHaveBeenCalled()

    internals.runtime = undefined
    await app.shutdown()
  })

  it('dismisses an open btw block on Escape without interrupting the main reply', async () => {
    const runtime = {
      session: { isStreaming: true },
      interrupt: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
      snapshot: vi.fn(() => undefined)
    }
    const dismiss = vi.fn(async () => {})
    const app = new OpenTuiApplication([])
    const internals = app as unknown as {
      runtime?: TerminalRuntime
      sideQuestion?: { visible: boolean; dismiss(): Promise<void> }
      keybindings?: { matches(data: string, action: string): boolean }
    }
    internals.runtime = runtime as unknown as TerminalRuntime
    internals.sideQuestion = { visible: true, dismiss }
    internals.keybindings = { matches: (data, action) => data === '\x1b' && action === 'app.interrupt' }

    expect(app.handleKey(key('escape', '\x1b'))).toBe(true)
    expect(dismiss).toHaveBeenCalledOnce()
    expect(runtime.interrupt).not.toHaveBeenCalled()

    internals.sideQuestion = undefined
    await app.shutdown()
  })

  it('interrupts a pending question when Escape cancels its dock', async () => {
    const runtime = {
      pending: vi.fn(async () => [question('q1')]),
      answer: vi.fn(async () => {}),
      answerBatch: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      snapshot: vi.fn(() => undefined)
    }
    const app = new OpenTuiApplication([])
    const internals = app as unknown as {
      runtime?: TerminalRuntime
      decisions(): Promise<void>
    }
    internals.runtime = runtime as unknown as TerminalRuntime

    const decision = internals.decisions()
    for (let index = 0; index < 5 && !app.view().questionDock; index += 1) await Promise.resolve()
    expect(app.view().questionDock).not.toBeNull()
    expect(app.handleKey(key('escape', '\x1b'))).toBe(true)
    await decision

    expect(runtime.interrupt).toHaveBeenCalledOnce()
    expect(runtime.answer).not.toHaveBeenCalled()
    expect(app.view().questionDock).toBeNull()

    internals.runtime = undefined
    await app.shutdown()
  })

  it('sends a character the question dock does not use to the composer instead of dropping it', async () => {
    const runtime = {
      pending: vi.fn(async () => [question('q1', { options: [{ label: 'First', recommended: true }, { label: 'Second' }] })]),
      answer: vi.fn(async () => {}),
      answerBatch: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      snapshot: vi.fn(() => undefined)
    }
    const app = new OpenTuiApplication([])
    const internals = app as unknown as { runtime?: TerminalRuntime; decisions(): Promise<void>; syncDraft(text: string): void }
    internals.runtime = runtime as unknown as TerminalRuntime
    internals.syncDraft = () => {}

    void internals.decisions()
    for (let index = 0; index < 5 && !app.view().questionDock; index += 1) await Promise.resolve()
    expect(app.view().questionDock?.focus).toBe('options')

    expect(app.handleKey(key('h', 'h'))).toBe(true)
    expect(app.view().questionDock?.focus).toBe('composer')
    expect(app.view().draft).toBe('h')
    expect(runtime.answer).not.toHaveBeenCalled()

    internals.runtime = undefined
    await app.shutdown()
  })
})
