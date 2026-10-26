import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionInfo, Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHarnessTheme } from './theme'
import type { TerminalMouseInput } from './mouse'
import { formatSessionRelativeTime, formatSessionSize, ResumeSessionsPage } from './sessionPicker'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const directories: string[] = []

function pointerMove(y: number): TerminalMouseInput {
  return { type: 'move', button: 'none', x: 0, y, screenX: 0, screenY: y, width: 100, height: 20, shift: false, alt: false, ctrl: false }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'resume-session-picker-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('resume session picker', () => {
  it('formats relative time and binary file sizes semantically', () => {
    expect(formatSessionRelativeTime(new Date(1_000_000 - 180_000), 1_000_000)).toBe('3 minutes ago')
    expect(formatSessionRelativeTime(new Date(1_000_000), 1_000_000)).toBe('now')
    expect(formatSessionSize(5.1 * 1024 * 1024)).toBe('5.1MB')
    expect(formatSessionSize(undefined)).toBe('—')
  })

  it('shows unnumbered titles above muted relative time, project:branch and file size', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'session.jsonl')
    await writeFile(path, 'x'.repeat(8192))
    const modified = new Date(Date.now() - 179_000)
    const session: SessionInfo = {
      path,
      id: 'session-id',
      cwd: '/workspace/fixture-project',
      name: 'Fixture conversation',
      created: new Date(0),
      modified,
      messageCount: 1,
      firstMessage: 'A first message for searching',
      allMessagesText: 'A first message for searching'
    }
    const otherPath = join(directory, 'other-session.jsonl')
    await writeFile(otherPath, 'y'.repeat(4096))
    const otherSession: SessionInfo = {
      ...session,
      path: otherPath,
      id: 'other-session-id',
      name: 'Other conversation',
      modified: new Date(Date.now() - 300_000),
      firstMessage: 'Another message',
      allMessagesText: 'Another message'
    }
    const select = vi.fn()
    const changed = vi.fn()
    const page = new ResumeSessionsPage({
      theme: () => theme,
      cwd: () => '/workspace/fixture-project',
      branch: () => 'feature/resume',
      listSessions: async () => [session, otherSession],
      select,
      cancel: vi.fn(),
      changed
    })

    expect(page.presentation).toBe('fullscreen')
    page.activate()
    await vi.waitFor(() => expect(page.render(100, 20).map(stripTerminalSequences).join('\n')).toContain('Fixture conversation'))
    let lines = page.render(100, 20).map(stripTerminalSequences)
    const titleAt = lines.findIndex(line => line.includes('Fixture conversation'))
    expect(lines[titleAt]).toContain('❯ Fixture conversation')
    expect(lines[titleAt]).not.toMatch(/^\s*1\./)
    expect(lines[titleAt + 1]).toContain('3 minutes ago · fixture-project:feature/resume · 8.0KB')
    expect(lines[titleAt + 2]).toBe('')
    expect(lines[titleAt + 3]).toContain('Other conversation')
    const changedBeforeMove = changed.mock.calls.length
    expect(page.handleMouse(pointerMove(titleAt + 3))).toEqual({ handled: true, render: false })
    expect(changed).toHaveBeenCalledTimes(changedBeforeMove)
    expect(page.render(100, 20).map(stripTerminalSequences)).toEqual(lines)
    expect(page.handleInput('feature')).toBe(true)
    lines = page.render(100, 20).map(stripTerminalSequences)
    expect(lines.join('\n')).toContain('feature/resume')
    expect(lines.filter(line => line.includes('Fixture conversation'))).toHaveLength(1)
    expect(page.handleInput('\r')).toBe(true)
    expect(select).toHaveBeenCalledWith(path)
    expect(changed).toHaveBeenCalled()
    page.dispose()
  })
})
