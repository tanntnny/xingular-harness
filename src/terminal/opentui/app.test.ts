import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyToClipboard } from '@earendil-works/pi-coding-agent'
import type { AgentSession, AgentSessionEvent, Theme } from '@earendil-works/pi-coding-agent'
import type { Component } from '@earendil-works/pi-tui'

vi.mock('@earendil-works/pi-coding-agent', async importOriginal => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>()
  return { ...actual, copyToClipboard: vi.fn(async (_text: string) => {}) }
})

import type { LinkTarget } from '../../core/links'
import { OpenTuiApplication, type KeyInput } from './app'
import { PiDialogHost } from './dialogHost'
import type { ComposerAttachments } from './attachments'
import { TranscriptModel } from './model'
import { QuestionDockState, type QuestionDockQuestion } from './questionDockState'
import { workingLineText } from './workingLine'
import { createHarnessTheme } from '../tui/theme'
import type { TerminalDecision, TerminalRuntime } from '../tui/runtime'
import type { TerminalSubagentActivity } from '../subagentMonitor'
import type { TerminalCommandHelpGroup } from '../commandHelp'

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

  it('refreshes the working name on native metadata changes and retains it after completion', async () => {
    const app = new OpenTuiApplication([])
    let name = 'Inspect browser tools'
    const internals = app as unknown as { accept(event: AgentSessionEvent): void; runtime?: TerminalRuntime }
    internals.runtime = {
      session: { messages: [], state: {}, getSessionStats: () => ({ tokens: {} }) },
      snapshot: () => ({ name, context: { percent: null } }), dispose: async () => {}
    } as unknown as TerminalRuntime
    internals.accept({ type: 'agent_start' } as AgentSessionEvent)
    expect(workingLineText(app.view().working)).toContain(' – Inspect browser tools')
    name = 'Add web browser integrations'
    internals.accept({ type: 'session_info_changed', name } as AgentSessionEvent)
    expect(workingLineText(app.view().working)).toContain(' – Add web browser integrations')
    internals.accept({ type: 'agent_settled', aborted: false } as AgentSessionEvent)
    expect(workingLineText(app.view().working)).toContain(' – Add web browser integrations')
    await app.shutdown()
  })

  it('keeps the welcome for one-line notices and hides it for generic multiline output', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as { notify(message: string, type?: string): void }

    internals.notify('Starting session…')
    expect(app.view().home).toBe(true)

    internals.notify('first line\nsecond line')
    expect(app.view().home).toBe(false)
    await app.shutdown()
  })

  it('publishes and refreshes the active slash-command vocabulary', async () => {
    const app = new OpenTuiApplication([])
    let completions = [{ name: 'help', aliases: ['h'] }, { name: 'annotate:notes' }, { name: 'review' }]
    let skills = [{ name: 'diagnose' }]
    let legacyAliases = ['plugin:notes', 'notes']
    const internals = app as unknown as {
      commands: { completions(): typeof completions; skills(): typeof skills; legacyAliases(): string[] }
      refresh(): void
    }
    internals.commands = { completions: () => completions, skills: () => skills, legacyAliases: () => legacyAliases }

    expect(app.view().slashCommandNames).toEqual(['help', 'h', 'annotate:notes', 'review', 'skill:diagnose', 'plugin:notes', 'notes'])
    expect(app.view().skillNames).toEqual(['diagnose'])

    completions = [{ name: 'plan' }]
    skills = [{ name: 'inspect' }]
    legacyAliases = ['plugin:doctor', 'doctor']
    internals.refresh()
    expect(app.view().slashCommandNames).toEqual(['plan', 'skill:inspect', 'plugin:doctor', 'doctor'])
    expect(app.view().skillNames).toEqual(['inspect'])
    await app.shutdown()
  })

  it('shows grouped help as one transcript item and replaces the welcome', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as { showHelp(groups: TerminalCommandHelpGroup[]): void }
    const groups: TerminalCommandHelpGroup[] = [
      { name: 'Core', commands: [{ name: 'help', description: 'List commands' }] }
    ]

    internals.showHelp(groups)

    expect(app.view().home).toBe(false)
    expect(app.view().items).toMatchObject([{ kind: 'command-help', groups }])
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

  it('shows work after compaction without a compacting notice', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as { accept(event: AgentSessionEvent): void; runtime?: TerminalRuntime }
    const before = Array.from({ length: 30 }, (_, index) => ({ role: 'user', content: `message ${index}` }))
    const session = { messages: before as unknown[], state: {} }
    internals.runtime = { session, snapshot: () => undefined, dispose: async () => {} } as unknown as TerminalRuntime
    ;(app as unknown as { transcript: { bind(session: unknown): void } }).transcript.bind(session)

    internals.accept({ type: 'compaction_start', reason: 'threshold' } as AgentSessionEvent)
    session.messages = [{ role: 'compactionSummary', summary: 'Earlier work.', tokensBefore: 50_000 }, ...before.slice(-2)]
    internals.accept({ type: 'compaction_end', reason: 'threshold', result: { summary: 'Earlier work.', tokensBefore: 50_000 } } as AgentSessionEvent)
    session.messages.push({ role: 'assistant', content: 'next step' })
    internals.accept({ type: 'message_end', message: session.messages.at(-1) } as AgentSessionEvent)

    const items = app.view().items
    expect(items.at(-1)).toMatchObject({ kind: 'assistant', text: 'next step' })
    expect(items.some(item => item.kind === 'notice')).toBe(false)
    await app.shutdown()
  })

  it('shows a /compact while idle in the working line with the spinner', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as { accept(event: AgentSessionEvent): void; runtime?: TerminalRuntime }
    internals.runtime = {
      session: { messages: [{ role: 'user', content: 'hello' }], state: {}, getSessionStats: () => ({ tokens: {} }) },
      snapshot: () => undefined,
      dispose: async () => {}
    } as unknown as TerminalRuntime

    expect(app.view().working.active).toBe(false)
    internals.accept({ type: 'compaction_start', reason: 'manual' } as AgentSessionEvent)
    const working = app.view().working
    expect(working).toMatchObject({ active: true, label: 'Compacting context' })
    expect(working.frame).not.toBe('')
    expect(working.elapsedMs).toEqual(expect.any(Number))
    expect(working.tokensPerSecond).toBeNull()
    internals.accept({ type: 'compaction_end', reason: 'manual', result: { summary: 'short', tokensBefore: 10 } } as AgentSessionEvent)
    expect(app.view().working).toMatchObject({ active: false, label: '' })
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

  it('puts retry updates in chat and shows compaction in the working line', async () => {
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

    const runElapsed = app.view().working.elapsedMs
    internals.accept({ type: 'compaction_start', reason: 'threshold' } as AgentSessionEvent)
    expect(app.view().working).toMatchObject({ active: true, label: 'Compacting context' })
    expect(app.view().working.elapsedMs).toBeGreaterThanOrEqual(runElapsed ?? 0)
    expect(app.view().items.some(item => item.kind === 'notice' && item.text === 'Compacting context…')).toBe(false)
    internals.accept({
      type: 'summarization_retry_scheduled', attempt: 2, maxAttempts: 4, delayMs: 2500, errorMessage: 'temporary failure'
    } as AgentSessionEvent)
    expect(app.view().items.at(-1)).toMatchObject({
      kind: 'notice', level: 'warning', text: 'Retry 2/4 in 2.5s: temporary failure'
    })
    internals.accept({
      type: 'summarization_retry_attempt_start', source: 'compaction', reason: 'threshold'
    } as AgentSessionEvent)
    expect(app.view().working.label).toBe('Retrying compaction')
    expect(app.view().items.at(-1)).toMatchObject({ kind: 'notice', text: 'Retry 2/4 in 2.5s: temporary failure' })
    internals.accept({ type: 'summarization_retry_attempt_start', source: 'branchSummary' } as AgentSessionEvent)
    expect(app.view().items.at(-1)).toMatchObject({ kind: 'notice', text: 'Retrying branch summary…' })
    internals.accept({ type: 'summarization_retry_finished' } as AgentSessionEvent)
    expect(app.view().items.at(-1)).toMatchObject({ kind: 'notice', text: 'Summarization retry finished.' })
    internals.accept({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false } as AgentSessionEvent)
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

  it('renders subagent rows separately and retains the final status until the next run', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as {
      subagents: TerminalSubagentActivity[]
      themeValue: Theme
      accept(event: AgentSessionEvent): void
    }
    internals.themeValue = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
    internals.subagents = [{
      id: 'child', parentRunId: 'parent', relation: 'subagent', goal: 'Inspect auth flow', status: 'running',
      startedAt: new Date(Date.now() - 3000).toISOString(), endedAt: null, activity: 'read',
      profile: { name: 'explorer', color: 'cyan' }, title: 'Map the auth flow', todo: { done: 1, total: 3 }, usage: null
    }]

    expect(app.view().widgets.above).toEqual([])
    expect(app.view().subagents?.rows).toEqual([expect.objectContaining({ mark: expect.stringMatching(/^[·✢✳✶✻✽]$/u), profile: 'explorer', color: 'cyan', title: 'Map the auth flow', tasks: '1 of 3 tasks' })])
    internals.subagents = [{
      ...internals.subagents[0]!, status: 'completed', endedAt: new Date().toISOString(), activity: 'Completed'
    }]
    internals.accept({ type: 'agent_settled' } as AgentSessionEvent)
    expect(app.view().subagents?.rows).toEqual([expect.objectContaining({ mark: '✓', title: 'Map the auth flow' })])

    internals.accept({ type: 'agent_start' } as AgentSessionEvent)
    expect(app.view().subagents).toBeNull()
    await app.shutdown()
  })

  it('shows a reopened conversation’s restored rows with no run active, the main row only on the page', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as {
      subagents: TerminalSubagentActivity[]
      runtime?: TerminalRuntime
      accept(event: AgentSessionEvent): void
      refreshSubagents(settled?: boolean): Promise<void>
      readSubagentMonitor(): Promise<{ children: TerminalSubagentActivity[] }>
    }
    internals.runtime = {
      session: { getActiveToolNames: () => ['spawn_subagent'], messages: [], state: {} },
      snapshot: () => undefined,
      dispose: async () => {}
    } as unknown as TerminalRuntime
    const stopped: TerminalSubagentActivity = {
      id: 'child', parentRunId: 'parent', relation: 'subagent', goal: 'Inspect auth flow', status: 'interrupted',
      startedAt: '2026-10-23T00:00:01.000Z', endedAt: '2026-10-23T00:00:09.000Z', activity: 'Interrupted',
      profile: { name: 'worker', color: 'green' }, title: 'Map the auth flow', todo: null, usage: null
    }
    const main: TerminalSubagentActivity = { ...stopped, id: 'parent', parentRunId: null, relation: 'main', profile: { name: 'main', color: 'main' }, title: 'Fix login' }
    internals.readSubagentMonitor = async () => ({ children: [main, stopped] })

    await internals.refreshSubagents(true)
    expect(internals.subagents.map(item => item.id)).toEqual(['parent', 'child'])
    expect(app.view().subagents?.rows).toEqual([expect.objectContaining({ id: 'child', mark: '!', title: 'Map the auth flow' })])
    internals.accept({ type: 'agent_start' } as AgentSessionEvent)
    expect(app.view().subagents).toBeNull()
    await app.shutdown()
  })

  it('refreshes final child statuses without applying an older in-flight poll', async () => {
    const app = new OpenTuiApplication([])
    let resolvePoll!: (value: { children: TerminalSubagentActivity[] }) => void
    let resolveFinal!: (value: { children: TerminalSubagentActivity[] }) => void
    const poll = new Promise<{ children: TerminalSubagentActivity[] }>(resolve => { resolvePoll = resolve })
    const final = new Promise<{ children: TerminalSubagentActivity[] }>(resolve => { resolveFinal = resolve })
    const running: TerminalSubagentActivity = {
      id: 'child', parentRunId: 'parent', relation: 'subagent', goal: 'Inspect auth flow', status: 'running',
      startedAt: new Date(Date.now() - 3000).toISOString(), endedAt: null, activity: 'read',
      profile: { name: 'explorer', color: 'cyan' }, title: 'Map the auth flow', todo: null, usage: null
    }
    const completed: TerminalSubagentActivity = {
      ...running, status: 'completed', endedAt: new Date().toISOString(), activity: 'Completed'
    }
    const internals = app as unknown as {
      startedAt: number | null
      runtime?: TerminalRuntime
      accept(event: AgentSessionEvent): void
      refreshSubagents(settled?: boolean): Promise<void>
      readSubagentMonitor(): Promise<{ children: TerminalSubagentActivity[] }>
    }
    internals.runtime = {
      session: { getActiveToolNames: () => ['spawn_subagent'], messages: [], state: {} },
      snapshot: () => undefined,
      dispose: async () => {}
    } as unknown as TerminalRuntime
    internals.startedAt = Date.now()
    let readCount = 0
    internals.readSubagentMonitor = () => ++readCount === 1 ? poll : final

    const inFlight = internals.refreshSubagents()
    internals.accept({ type: 'agent_settled' } as AgentSessionEvent)
    resolvePoll({ children: [running] })
    await inFlight
    expect(app.view().subagents).toBeNull()

    resolveFinal({ children: [completed] })
    await vi.waitFor(() => expect(app.view().subagents?.rows).toEqual([expect.objectContaining({ mark: '✓', title: 'Map the auth flow' })]))
    await app.shutdown()
  })

  it('shows successful selection copies as a temporary toast, not a transcript notice', async () => {
    vi.useFakeTimers()
    const app = new OpenTuiApplication([])
    try {
      vi.mocked(copyToClipboard).mockClear()
      app.copySelection('selected TUI text')
      await Promise.resolve()
      await Promise.resolve()

      expect(copyToClipboard).toHaveBeenCalledWith('selected TUI text')
      expect(app.view().toast).toBe('Copied to clipboard')
      expect(app.view().items).toHaveLength(0)
      vi.advanceTimersByTime(2499)
      expect(app.view().toast).toBe('Copied to clipboard')
      vi.advanceTimersByTime(1)
      expect(app.view().toast).toBeNull()
    } finally {
      await app.shutdown()
      vi.useRealTimers()
    }
  })

  it('browses active-session prompts at composer edges and restores the working draft', async () => {
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
    const edge = (name: 'up' | 'down', first: boolean, last: boolean, cursorOffset?: number) => ({
      ...key(name, name === 'up' ? '\x1b[A' : '\x1b[B'),
      atFirstVisualLine: first, atLastVisualLine: last, cursorOffset
    })
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
      expect(app.handleKey(edge('up', false, true, 12))).toBe(true)
      expect(app.view().draft).toBe('second prompt')
      expect(app.handleKey(edge('up', true, false, 0))).toBe(true)
      expect(app.view().draft).toBe('first prompt')
      expect(app.handleKey(edge('down', true, false, 0))).toBe(true)
      expect(app.view().draft).toBe('second prompt')
      expect(app.handleKey(edge('down', false, true, 13))).toBe(true)
      expect(app.view().draft).toBe('third prompt')
      expect(app.handleKey(edge('down', false, true, 12))).toBe(true)
      expect(app.view().draft).toBe('')

      app.setDraft('unfinished draft')
      expect(app.handleKey(edge('down', true, true, 4))).toBe(true)
      expect(app.view()).toMatchObject({ draft: 'unfinished draft', draftCursorOffset: 'unfinished draft'.length })
      expect(app.handleKey(edge('up', true, true, 'unfinished draft'.length))).toBe(true)
      expect(app.view()).toMatchObject({ draft: 'third prompt', draftCursorOffset: 'third prompt'.length })
      expect(app.handleKey(edge('down', true, true, 0))).toBe(true)
      expect(app.view()).toMatchObject({ draft: 'unfinished draft', draftCursorOffset: 'unfinished draft'.length })

      app.setDraft('scratch first\nscratch second')
      expect(app.handleKey(edge('up', false, true, 25))).toBe(false)
      expect(app.view().draft).toBe('scratch first\nscratch second')
      expect(app.handleKey(edge('up', true, false, 12))).toBe(true)
      expect(app.view()).toMatchObject({ draft: 'scratch first\nscratch second', draftCursorOffset: 0 })
      expect(app.handleKey(edge('up', true, false, 0))).toBe(true)
      expect(app.view().draft).toBe('third prompt')
      expect(app.handleKey(edge('down', false, true, 12))).toBe(true)
      expect(app.view().draft).toBe('scratch first\nscratch second')
      expect(app.view().draftCursorOffset).toBe(0)

      expect(app.handleKey({ ...key('up', '\x1b[1;5A'), ctrl: true })).toBe(true)
      expect(app.view().draft).toBe('third prompt')
      expect(app.handleKey({ ...key('up', '\x1b[1;5A'), ctrl: true })).toBe(true)
      expect(app.view().draft).toBe('second prompt')
      expect(app.handleKey({ ...key('down', '\x1b[1;5B'), ctrl: true })).toBe(true)
      expect(app.view().draft).toBe('third prompt')
      expect(app.handleKey({ ...key('down', '\x1b[1;5B'), ctrl: true })).toBe(true)
      expect(app.view().draft).toBe('scratch first\nscratch second')
      expect(app.handleKey(key('up', '\x1b[1;2A', true))).toBe(true)
      expect(setThinkingLevel).toHaveBeenCalledWith('high')
      expect(app.view().draft).toBe('scratch first\nscratch second')

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

  it('recalls user-entered Bash commands into the composer in Bash mode', async () => {
    const app = new OpenTuiApplication([])
    const session = {
      messages: [
        { role: 'user', content: 'older request', timestamp: 100 },
        { role: 'bashExecution', command: 'git status --short', output: '', timestamp: 200 },
        { role: 'user', content: 'newer request', timestamp: 300 }
      ],
      state: {},
      getSessionStats: () => ({ tokens: { input: 0, output: 0 } })
    } as unknown as AgentSession
    const internals = app as unknown as { transcript: TranscriptModel; runtime?: TerminalRuntime }
    internals.runtime = { session, snapshot: () => undefined, dispose: async () => {} } as unknown as TerminalRuntime
    internals.transcript.bind(session)

    try {
      expect(app.handleKey(key('up', '\x1b[A'))).toBe(true)
      expect(app.view().draft).toBe('newer request')
      expect(app.handleKey({ ...key('up', '\x1b[A'), atFirstVisualLine: true, cursorOffset: 6 })).toBe(true)
      expect(app.view()).toMatchObject({ draft: 'newer request', draftCursorOffset: 0, bashMode: false })
      expect(app.handleKey({ ...key('up', '\x1b[A'), atFirstVisualLine: true, cursorOffset: 0 })).toBe(true)
      expect(app.view()).toMatchObject({ draft: 'git status --short', bashMode: true })
      expect(app.handleKey({ ...key('up', '\x1b[A'), atFirstVisualLine: true, cursorOffset: 18 })).toBe(true)
      expect(app.view()).toMatchObject({ draft: 'older request', bashMode: false })
      expect(app.handleKey({ ...key('down', '\x1b[B'), atFirstVisualLine: true, cursorOffset: 0 })).toBe(true)
      expect(app.view()).toMatchObject({ draft: 'git status --short', bashMode: true })
    } finally {
      await app.shutdown()
    }
  })

  it('recalls executed slash commands alongside session prompts', async () => {
    const app = new OpenTuiApplication([])
    const session = {
      messages: [{ role: 'user', content: 'saved request', timestamp: 100 }],
      state: {},
      getSessionStats: () => ({ tokens: { input: 0, output: 0 } })
    } as unknown as AgentSession
    const execute = vi.fn(async (_text: string) => true)
    const internals = app as unknown as {
      transcript: TranscriptModel
      runtime?: TerminalRuntime
      commands?: {
        execute(text: string): Promise<boolean>
        expandSkill(text: string): string
        completions(): { name: string }[]
        skills(): { name: string }[]
        legacyAliases(): string[]
      }
      slashCommandHistory: { text: string; timestamp: number }[]
      syncDraft(text: string): void
      initialized: boolean
    }
    internals.runtime = { session, snapshot: () => undefined, dispose: async () => {} } as unknown as TerminalRuntime
    internals.commands = {
      execute, expandSkill: text => text,
      completions: () => [{ name: 'plugin:annotate' }], skills: () => [], legacyAliases: () => []
    }
    internals.syncDraft = () => {}
    internals.initialized = true
    internals.transcript.bind(session)

    try {
      app.setDraft('/plugin:annotate')
      app.submitPrompt()
      await vi.waitFor(() => expect(internals.slashCommandHistory).toHaveLength(1))
      expect(execute).toHaveBeenCalledWith('/plugin:annotate')
      expect(app.handleKey(key('up', '\x1b[A'))).toBe(true)
      expect(app.view().draft).toBe('/plugin:annotate')
      expect(app.view().palette).toBeNull()
      expect(app.handleKey({ ...key('up', '\x1b[A'), atFirstVisualLine: true, cursorOffset: 16 })).toBe(true)
      expect(app.view().draft).toBe('saved request')
      expect(app.handleKey({ ...key('down', '\x1b[B'), ctrl: true })).toBe(true)
      expect(app.view().draft).toBe('/plugin:annotate')
      expect(app.view().palette).toBeNull()
      app.setDraft('/plugin:annotatex')
      app.setDraft('/plugin:annotate')
      expect(app.view().palette?.items).toMatchObject([{ name: 'plugin:annotate' }])
    } finally {
      await app.shutdown()
    }
  })

  it('hides skill suggestions when recalling history and restores them when editing', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as {
      commands: { skills(): { name: string }[]; completions(): { name: string }[] }
      slashCommandHistory: { text: string; timestamp: number }[]
      syncDraft(text: string): void
    }
    internals.commands = { skills: () => [{ name: 'example' }], completions: () => [] }
    internals.slashCommandHistory = [{ text: '$example', timestamp: 1 }]
    internals.syncDraft = () => {}
    try {
      expect(app.handleKey(key('up', '\x1b[A'))).toBe(true)
      expect(app.view().draft).toBe('$example')
      expect(app.view().palette).toBeNull()
      app.setDraft('$exampl')
      expect(app.view().palette?.items).toMatchObject([{ name: 'example' }])
    } finally {
      await app.shutdown()
    }
  })

  it('keeps draft attachment payloads while history temporarily replaces the composer', async () => {
    const app = new OpenTuiApplication([])
    const oldPrompt = 'Earlier [Image #1] [Pasted text #2 +4 lines]'
    const session = {
      messages: [{ role: 'user', content: oldPrompt }], state: {},
      getSessionStats: () => ({ tokens: {} })
    } as unknown as AgentSession
    const internals = app as unknown as {
      attachments: ComposerAttachments
      transcript: TranscriptModel
      runtime?: TerminalRuntime
      syncDraft(text: string): void
    }
    internals.runtime = { session, snapshot: () => undefined, dispose: async () => {} } as unknown as TerminalRuntime
    internals.transcript.bind(session)
    internals.syncDraft = () => {}
    const image = internals.attachments.addImage('image-data', 'image/png')
    const paste = internals.attachments.addText('one\ntwo\nthree\nfour')
    const scratch = `Review ${image.label} ${paste.label}`
    app.setDraft(scratch)

    try {
      expect(app.handleKey({ ...key('up', '\x1b[A'), atFirstVisualLine: true, cursorOffset: 0 })).toBe(true)
      expect(app.view().draft).toBe(oldPrompt)
      expect(app.view().attachments).toEqual([])
      expect(internals.attachments.expand(oldPrompt)).toEqual({ text: oldPrompt, images: [] })
      expect(app.handleKey({ ...key('down', '\x1b[B'), atLastVisualLine: true, cursorOffset: oldPrompt.length })).toBe(true)
      expect(app.view().draft).toBe(scratch)
      expect(app.view().attachments).toEqual([
        expect.objectContaining({ label: image.label }), expect.objectContaining({ label: paste.label })
      ])
      expect(internals.attachments.expand(scratch)).toEqual({
        text: 'Review [Image #1] one\ntwo\nthree\nfour',
        images: [{ type: 'image', data: 'image-data', mimeType: 'image/png' }]
      })
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

  it('routes pasted text into an active dialog without changing the composer draft', async () => {
    const app = new OpenTuiApplication([])
    const inputs: string[] = []
    const internals = app as unknown as { host: PiDialogHost }
    internals.host.showOverlay({
      render: () => ['dialog'],
      handleInput: (data: string) => inputs.push(data),
      invalidate: () => {}
    } as unknown as Component)

    try {
      app.paste('annotation note\r\ncontinued')
      await vi.waitFor(() => expect(inputs).toEqual(['\x1b[200~annotation note\ncontinued\x1b[201~']))
      expect(app.view().draft).toBe('')
    } finally {
      await app.shutdown()
    }
  })

  it('routes the clipboard shortcut to an active dialog as text', async () => {
    const app = new OpenTuiApplication([])
    const inputs: string[] = []
    const internals = app as unknown as {
      host: PiDialogHost
      keybindings: { matches(data: string, action: string): boolean }
      readClipboardText(): Promise<string | null>
    }
    internals.host.showOverlay({
      render: () => ['dialog'],
      handleInput: (data: string) => inputs.push(data),
      invalidate: () => {}
    } as unknown as Component)
    internals.keybindings = {
      matches: (data, action) => data === '\x16' && action === 'app.clipboard.pasteImage'
    }
    internals.readClipboardText = async () => 'API_KEY_FROM_CLIPBOARD'

    try {
      expect(app.handleKey({ ...key('v', '\x16'), ctrl: true })).toBe(true)
      await vi.waitFor(() => expect(inputs).toEqual(['\x1b[200~API_KEY_FROM_CLIPBOARD\x1b[201~']))
      expect(app.view().draft).toBe('')
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

  it('keeps a batch in the question dock until the full answer is submitted', async () => {
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
    expect(app.view().questionDock?.focus).toBe('options')

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

  it('leaves question scrolling to the dock before effort, history and answer shortcuts', async () => {
    const app = new OpenTuiApplication([])
    const dock = new QuestionDockState([{
      ...question('q1'), type: 'question', uiSketch: true,
      options: [{ label: 'A', recommended: true, sketch: 'A' }, { label: 'B', sketch: 'B' }]
    }])
    const internals = app as unknown as { questionDock?: QuestionDockState }
    internals.questionDock = dock
    dock.toggleOption(0)
    for (const name of ['up', 'down', 'left', 'right']) {
      expect(app.handleKey(key(name, '', true))).toBe(false)
    }
    for (const name of ['pageup', 'pagedown', 'home', 'end']) {
      expect(app.handleKey({ ...key(name, ''), ctrl: name === 'home' || name === 'end' })).toBe(false)
    }
    expect(dock.view).toMatchObject({ selected: ['A'], optionIndex: 0, text: '', focus: 'options' })
    expect(app.handleKey(key('down', '\u001b[B'))).toBe(true)
    expect(dock.view.optionIndex).toBe(1)
    expect(dock.view.selected).toEqual(['A'])
    for (const focus of ['note', 'answer'] as const) {
      dock.setFocus(focus)
      expect(app.handleKey(key('?', '?'))).toBe(false)
      expect(app.handleKey(key('!', '!'))).toBe(false)
      expect(app.view().bashMode).toBe(false)
    }
    await app.shutdown()
  })

  it('navigates all command and skill suggestions without recalling history', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as {
      commands: { completions(): { name: string }[]; skills(): { name: string }[] }
      syncDraft(text: string): void
    }
    const items = Array.from({ length: 12 }, (_, index) => ({ name: `item${String(index).padStart(2, '0')}` }))
    internals.commands = { completions: () => items, skills: () => items }
    internals.syncDraft = () => {}
    try {
      for (const prefix of ['/', '$']) {
        app.setDraft(prefix)
        expect(app.view().palette?.items).toHaveLength(12)
        for (let index = 0; index < 9; index++) {
          expect(app.handleKey({ ...key('down', '\x1b[B'), cursorOffset: 1, atLastVisualLine: true })).toBe(true)
        }
        expect(app.view().palette?.index).toBe(9)
        expect(app.view().draft).toBe(prefix)
        expect(app.handleKey({ ...key('up', '\x1b[A'), cursorOffset: 1, atFirstVisualLine: true })).toBe(true)
        expect(app.view().palette?.index).toBe(8)
      }
    } finally {
      await app.shutdown()
    }
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

  it('shows aliases once in the palette and selects the canonical command name', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as {
      commands: { completions(): { name: string; aliases?: string[]; description?: string }[] }
      syncDraft(text: string): void
      submit(text: string): void
    }
    internals.commands = { completions: () => [{ name: 'session', aliases: ['resume'], description: 'Choose a saved session' }] }
    internals.syncDraft = () => {}
    const submit = vi.fn()
    internals.submit = submit

    app.setDraft('/res')
    expect(app.view().palette?.items).toMatchObject([{ name: 'session', aliases: ['resume'] }])
    expect(app.view().palette?.items).toHaveLength(1)
    expect(app.activatePaletteItem(0)).toBe(true)
    expect(submit).toHaveBeenCalledWith('/session')

    await app.shutdown()
  })

  it('places the cursor after a slash command inserted with Tab', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as {
      commands: { completions(): { name: string; description?: string }[] }
      syncDraft(text: string): void
    }
    internals.commands = { completions: () => [{ name: 'plan', description: 'Plan mode' }] }
    internals.syncDraft = () => {}

    try {
      app.setDraft('/pla')
      expect(app.view().palette?.items).toMatchObject([{ name: 'plan' }])
      expect(app.handleKey(key('tab', '\t'))).toBe(true)
      expect(app.view()).toMatchObject({ draft: '/plan ', draftCursorOffset: '/plan '.length, palette: null })
    } finally {
      await app.shutdown()
    }
  })

  it('preserves an existing draft and attachments while filtering and opening the resource browser', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as {
      commands: { completions(): { name: string }[]; execute(text: string): Promise<boolean> }
      attachments: import('./attachments').ComposerAttachments
      openPalette(): void
      syncDraft(text: string): void
      submit(text: string): void
      draft: string
    }
    internals.syncDraft = () => {}
    const image = internals.attachments.addImage('image-data', 'image/png')
    app.setDraft(`Review this ${image.label}`)
    const execute = vi.fn(async () => {
      app.setDraftExternal(`$review ${internals.draft}`)
      return true
    })
    internals.commands = { completions: () => [{ name: 'skills' }], execute }
    internals.submit = vi.fn()
    internals.openPalette()
    app.setDraft('skills')
    expect(app.view().draft).toBe('skills')
    expect(app.activatePaletteItem(0)).toBe(true)
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith('/skills'))
    expect(app.view().draft).toBe(`$review Review this ${image.label}`)
    expect(internals.attachments.expand(app.view().draft).images).toEqual([{ type: 'image', data: 'image-data', mimeType: 'image/png' }])
    expect(internals.submit).not.toHaveBeenCalled()
    await app.shutdown()
  })

  it('offers loaded skills at $ and inserts without submitting a model request', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as {
      commands: { skills(): { name: string; description: string }[] }
      syncDraft(text: string): void
      submit(text: string): void
    }
    internals.commands = { skills: () => [{ name: 'review', description: 'Inspect changes' }] }
    internals.syncDraft = () => {}
    internals.submit = vi.fn()
    app.setDraft('$rev')
    expect(app.view().palette?.items).toEqual([{ name: 'review', description: 'Inspect changes', prefix: '$' }])
    expect(app.activatePaletteItem(0)).toBe(true)
    expect(app.view().draft).toBe('$review ')
    expect(app.view().draftCursorOffset).toBe('$review '.length)
    expect(internals.submit).not.toHaveBeenCalled()
    expect(app.view().palette).toBeNull()
    await app.shutdown()
  })

  it('opens the link under the pointer, names the action, and reports a link it will not open', async () => {
    const opened: LinkTarget[] = []
    const openLink = vi.fn(async (target: LinkTarget) => { opened.push(target) })
    const setMousePointer = vi.fn()
    const getLinkIdAt = vi.fn(() => 7)
    let target: string | null = 'https://example.test/docs'
    const app = new OpenTuiApplication([], openLink)
    app.attachRenderer({
      suspend: async () => {}, resume: async () => {}, setTitle: () => {}, destroy: () => {},
      getLinkAt: () => target, getLinkIdAt, setMousePointer, requestRender: () => undefined
    })

    app.updateLinkHover(12, 4)
    expect(app.view().linkHovered).toBe(true)
    expect(app.linkHighlight).toEqual({ id: 7, x: 12, y: 4 })
    expect(setMousePointer).toHaveBeenLastCalledWith('pointer')
    expect(app.activateLinkAt(12, 4)).toBe(true)
    await vi.waitFor(() => expect(opened).toEqual([{ kind: 'web', url: 'https://example.test/docs' }]))
    expect(app.view().linkHovered).toBe(false)
    expect(app.linkHighlight).toBeNull()

    // A link this harness refuses is still a link: the click is answered, not passed to the composer.
    target = 'javascript:alert(1)'
    app.updateLinkHover(12, 4)
    expect(app.view().linkHovered).toBe(true)
    expect(app.activateLinkAt(12, 4)).toBe(true)
    expect(openLink).toHaveBeenCalledOnce()
    expect(app.view().items.some(item => item.kind === 'notice' && item.text.includes('cannot be opened here'))).toBe(true)

    target = null
    app.updateLinkHover(12, 4)
    expect(app.view().linkHovered).toBe(false)
    expect(app.activateLinkAt(12, 4)).toBe(false)
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

  it('gives plan-choice navigation precedence over prompt history', async () => {
    const app = new OpenTuiApplication([])
    const internals = app as unknown as {
      planChoice: { show(title: string): void; view: { index: number } | null }
      historyIndex?: number
      editPlan(): void
    }
    internals.planChoice.show('Verified plan')
    internals.historyIndex = 0
    const editPlan = vi.fn()
    internals.editPlan = editPlan

    expect(app.handleKey(key('down', '\x1b[B'))).toBe(true)
    expect(internals.planChoice.view).toMatchObject({ index: 1 })
    expect(app.handleKey(key('return', '\r'))).toBe(true)
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
    expect(app.handleKey(key('n', 'n'))).toBe(true)
    expect(app.view().questionDock).toMatchObject({
      focus: 'note',
      options: [
        { label: 'First', noteOpen: false },
        { label: 'Second', noteOpen: true, noteFocused: true }
      ]
    })
    app.setQuestionNote('Second', 'Context for this choice')
    expect(app.view().questionDock?.options[1]?.note).toBe('Context for this choice')
    expect(app.handleKey(key('tab', '\t'))).toBe(true)
    expect(app.view().questionDock?.focus).toBe('answer')
    app.focusQuestionAnswer()
    expect(app.view().questionDock?.focus).toBe('answer')

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

  it('routes unused question keys to free text without creating a chat draft or collapsing the dock', async () => {
    const runtime = {
      pending: vi.fn(async () => [question('q1', { options: [{ label: 'First', recommended: true }, { label: 'Second' }] })]),
      answer: vi.fn(async () => {}),
      answerBatch: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      snapshot: vi.fn(() => undefined)
    }
    const app = new OpenTuiApplication([])
    const internals = app as unknown as { runtime?: TerminalRuntime; decisions(): Promise<void>; syncDraft(text: string): void; questionDock?: QuestionDockState }
    internals.runtime = runtime as unknown as TerminalRuntime
    internals.syncDraft = () => {}

    void internals.decisions()
    for (let index = 0; index < 5 && !app.view().questionDock; index += 1) await Promise.resolve()
    expect(app.view().questionDock?.focus).toBe('options')

    expect(app.handleKey(key('h', 'h'))).toBe(true)
    expect(app.view().questionDock).toMatchObject({ focus: 'answer', text: 'h' })
    expect(app.view().draft).toBe('')

    internals.questionDock!.focusOption(0)
    expect(app.handleKey(key('x', 'x'))).toBe(true)
    expect(app.view().questionDock).toMatchObject({ focus: 'answer', text: 'hx' })
    expect(app.view().questionDock).not.toBeNull()
    expect(runtime.answer).not.toHaveBeenCalled()

    internals.runtime = undefined
    await app.shutdown()
  })
})
