import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Theme } from '@earendil-works/pi-coding-agent'
import { Container, TuiAltScreen, TuiMainScreen, VStack, stripTerminalSequences, type Component, type Terminal } from '@earendil-works/pi-tui'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDock, createTerminalScreen, mountTerminalLayout, readScreenPreferences, scrollbackLines, writeScrollback, type ScreenHooks, type ScreenPreferences } from './screen'
import { createHarnessTheme } from './theme'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const hooks: ScreenHooks = { theme: () => theme, latestKey: () => 'ctrl+end', openUrl: vi.fn(), pasteClipboard: vi.fn() }
const defaults = readScreenPreferences(undefined)
const prefs = (mode: ScreenPreferences['mode']): ScreenPreferences => ({ ...defaults, mode })

function fakeTerminal(columns = 40, rows = 12): Terminal {
  return {
    columns, rows, kittyProtocolActive: false, start: vi.fn(), stop: vi.fn(), drainInput: vi.fn(async () => {}), write: vi.fn(),
    moveBy: vi.fn(), hideCursor: vi.fn(), showCursor: vi.fn(), clearLine: vi.fn(), clearFromCursor: vi.fn(), clearScreen: vi.fn(),
    setTitle: vi.fn(), setProgress: vi.fn(), setProgramStatus: vi.fn()
  } as unknown as Terminal
}

/** A transcript whose rows the test changes, and a three-row dock standing in for the rule, prompt and footer. */
function panes(initial: string[]) {
  let transcript = initial
  const document = new Container()
  document.addChild({ render: () => [...transcript], invalidate: () => {} })
  const dock = new VStack([{ component: { render: () => ['─'.repeat(40), '❯ prompt', '? for shortcuts'], invalidate: () => {} }, shrink: 1, minSize: 0 }])
  return { document, dock, set(lines: string[]) { transcript = lines } }
}

function rowOf(lines: string[]): Component {
  return { render: () => [...lines], invalidate: () => {} }
}

function screenRows(tui: TuiAltScreen): string[] {
  return tui.getScreenLines().map(line => stripTerminalSequences(line).trimEnd())
}

describe('terminal screen preferences', () => {
  it('follows Pi fullscreen defaults when no account folder is prepared', () => {
    expect(defaults).toEqual({ mode: 'fullscreen', exitOutput: 'transcript', scrollbar: 'auto', wheelScrollLines: 'auto', copyOnSelect: true })
  })

  it('reads the regular screen from the account settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-screen-'))
    directories.push(directory)
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ tuiMode: 'regular' }))
    expect(readScreenPreferences(directory).mode).toBe('regular')
  })
})

describe('terminal screen layout', () => {
  it('keeps the dock on the last rows while the transcript is short', () => {
    const tui = createTerminalScreen(fakeTerminal(40, 12), prefs('fullscreen'), hooks) as TuiAltScreen
    const { document, dock } = panes(['Welcome'])
    mountTerminalLayout(tui, { document, dock }, prefs('fullscreen'), hooks)
    tui.start()
    tui.renderNow(true)
    const rows = screenRows(tui)
    expect(rows).toHaveLength(12)
    expect(rows[0]).toBe('Welcome')
    expect(rows.slice(-3)).toEqual(['─'.repeat(40), '❯ prompt', '? for shortcuts'])
    tui.stop()
  })

  it('does not move the dock as the transcript grows', () => {
    const tui = createTerminalScreen(fakeTerminal(40, 12), prefs('fullscreen'), hooks) as TuiAltScreen
    const { document, dock, set } = panes(['Welcome'])
    mountTerminalLayout(tui, { document, dock }, prefs('fullscreen'), hooks)
    tui.start()
    tui.renderNow(true)
    set(Array.from({ length: 30 }, (_, index) => `message ${index}`))
    tui.renderNow(true)
    const rows = screenRows(tui)
    expect(rows).toHaveLength(12)
    expect(rows.slice(-3)).toEqual(['─'.repeat(40), '❯ prompt', '? for shortcuts'])
    expect(rows[8]).toBe('message 29')
    tui.stop()
  })

  it('scrolls the transcript above a dock that stays where it is', () => {
    const tui = createTerminalScreen(fakeTerminal(40, 12), prefs('fullscreen'), hooks) as TuiAltScreen
    const { document, dock, set } = panes(Array.from({ length: 30 }, (_, index) => `message ${index}`))
    mountTerminalLayout(tui, { document, dock }, prefs('fullscreen'), hooks)
    tui.start()
    tui.renderNow(true)
    expect(tui.isFollowingOutput).toBe(true)
    tui.scrollBy(-10)
    tui.renderNow(true)
    expect(tui.isFollowingOutput).toBe(false)
    const rows = screenRows(tui)
    expect(rows.slice(-3)).toEqual(['─'.repeat(40), '❯ prompt', '? for shortcuts'])
    expect(rows.some(row => row === 'message 29')).toBe(false)
    set(['message 0'])
    tui.stop()
  })

  it('shows the first rows of a long notice while the prompt and status stay whole', () => {
    const tui = createTerminalScreen(fakeTerminal(40, 12), prefs('fullscreen'), hooks) as TuiAltScreen
    const notes = Array.from({ length: 20 }, (_, index) => `notice ${index}`)
    const dock = createDock({
      title: rowOf(['title']), above: rowOf([]), notes: rowOf(notes), below: rowOf([]), footer: rowOf(['status']),
      editor: rowOf(['─'.repeat(40), '❯ prompt', '─'.repeat(40), '? for shortcuts'])
    })
    const document = new Container()
    document.addChild(rowOf(['Welcome']))
    mountTerminalLayout(tui, { document, dock }, prefs('fullscreen'), hooks)
    tui.start()
    tui.renderNow(true)
    const rows = screenRows(tui)
    expect(rows).toHaveLength(12)
    expect(rows.slice(-5)).toEqual(['─'.repeat(40), '❯ prompt', '─'.repeat(40), '? for shortcuts', 'status'])
    expect(rows).toContain('notice 0')
    expect(rows).not.toContain('notice 19')
    tui.stop()
  })

  it('flows the regular screen in order without a viewport', () => {
    const tui = createTerminalScreen(fakeTerminal(), prefs('regular'), hooks)
    expect(tui).toBeInstanceOf(TuiMainScreen)
    const { document, dock } = panes(['Welcome'])
    expect(mountTerminalLayout(tui, { document, dock }, prefs('regular'), hooks)).toBeUndefined()
    expect(tui.children).toEqual([document, dock])
  })
})

describe('terminal scrollback on exit', () => {
  it('truncates the conversation to the terminal width', () => {
    const component: Component = { render: () => ['x'.repeat(30)], invalidate: () => {} }
    expect(scrollbackLines(component, 10).map(line => stripTerminalSequences(line))).toEqual(['x'.repeat(10)])
  })

  it('writes each line with its styles reset and CRLF endings', () => {
    const terminal = fakeTerminal()
    writeScrollback(terminal, ['first', 'second'])
    expect(terminal.write).toHaveBeenCalledWith('first\x1b[0m\r\nsecond\x1b[0m\r\n')
  })
})
