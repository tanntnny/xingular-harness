import type { AgentSession, Theme } from '@earendil-works/pi-coding-agent'
import type { TUI } from '@earendil-works/pi-tui'
import { expect, it, vi } from 'vitest'
import { TerminalTranscript } from './transcript'
import { createHarnessTheme } from './theme'

it('detaches all custom transcript components before their session is invalidated', () => {
  const first = { render: () => ['first'], invalidate() {}, dispose: vi.fn(() => { throw new Error('plugin cleanup failed') }) }
  const second = { render: () => ['second'], invalidate() {}, dispose: vi.fn() }
  const session = {
    settingsManager: { getHideThinkingBlock: () => false },
    sessionManager: { buildSessionProjection: () => ({ entries: [first, second].map((_, index) => ({ sourceEntry: { type: 'custom', customType: String(index) }, messages: [] })) }) },
    extensionRunner: { getEntryRenderer: (name: string) => () => [first, second][Number(name)] }
  } as unknown as AgentSession
  const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
  const transcript = new TerminalTranscript({} as TUI, () => theme, () => undefined)
  transcript.bind(session)
  expect(transcript.render(80)).toEqual(['first', 'second'])
  transcript.clearSession()
  expect(first.dispose).toHaveBeenCalledOnce()
  expect(second.dispose).toHaveBeenCalledOnce()
  expect(transcript.render(80)).toEqual([])
  transcript.clearSession()
  expect(second.dispose).toHaveBeenCalledOnce()
})

it('keeps notices in the conversation order and drops them with the session', () => {
  const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
  const transcript = new TerminalTranscript({} as TUI, () => theme, () => undefined)
  transcript.notice('Plan mode: only read-only tools are available.', 'info')
  transcript.notice('Plan mode could not start.', 'error')
  transcript.notice('Plan mode could not start.', 'error')
  const lines = transcript.render(80).map(line => line.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean)
  expect(lines).toEqual(['Plan mode: only read-only tools are available.', 'Plan mode could not start.'])
  transcript.notice('Plan mode: only read-only tools are available.', 'info')
  expect(transcript.render(80).map(line => line.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean)).toHaveLength(3)
  transcript.clearSession()
  expect(transcript.render(80)).toEqual([])
})
