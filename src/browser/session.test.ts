import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BrowserContext, Page } from 'playwright-core'
import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_BROWSER_CONFIG } from './config'
import type { NetworkPolicy } from './network'
import { BrowserSession, type Launcher } from './session'

function fakePage(): Page {
  return {
    url: () => 'about:blank',
    mainFrame: () => ({}),
    on: vi.fn(),
    close: vi.fn(async () => undefined)
  } as unknown as Page
}

function fakeContext(newPage: () => Promise<Page>) {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const context = {
    pages: () => [],
    newPage,
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener) }),
    route: vi.fn(async () => undefined),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    close: vi.fn(async () => { listeners.get('close')?.() })
  } as unknown as BrowserContext
  return { context, emitClose: () => listeners.get('close')?.() }
}

function setup(launch: Launcher) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-browser-session-'))
  const session = new BrowserSession({
    key: 'notes-test',
    profileDir: null,
    downloadsDir: dir,
    config: () => DEFAULT_BROWSER_CONFIG,
    network: { refusal: async () => null } as unknown as NetworkPolicy,
    launch,
    idleMs: 60_000,
    onIdle: () => undefined
  })
  return { dir, session }
}

describe('BrowserSession closed-context recovery', () => {
  it('relaunches once when a context closes before its first page is created', async () => {
    const stale = fakeContext(vi.fn().mockRejectedValue(new Error('browserContext.newPage: Target page, context or browser has been closed')))
    const page = fakePage()
    const fresh = fakeContext(vi.fn().mockResolvedValue(page))
    const launch = vi.fn(async () => ({ context: stale.context, browser: null, attached: false }))
      .mockResolvedValueOnce({ context: stale.context, browser: null, attached: false })
      .mockResolvedValueOnce({ context: fresh.context, browser: null, attached: false })
    const { dir, session } = setup(launch)
    try {
      expect((await session.tab()).page).toBe(page)
      expect(launch).toHaveBeenCalledTimes(2)
      expect(stale.context.close).toHaveBeenCalledOnce()
    } finally {
      await session.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('starts a new context after the active one closes', async () => {
    const firstPage = fakePage()
    const first = fakeContext(vi.fn().mockResolvedValue(firstPage))
    const secondPage = fakePage()
    const second = fakeContext(vi.fn().mockResolvedValue(secondPage))
    const launch = vi.fn(async () => ({ context: first.context, browser: null, attached: false }))
      .mockResolvedValueOnce({ context: first.context, browser: null, attached: false })
      .mockResolvedValueOnce({ context: second.context, browser: null, attached: false })
    const { dir, session } = setup(launch)
    try {
      expect((await session.tab()).page).toBe(firstPage)
      first.emitClose()
      expect((await session.tab()).page).toBe(secondPage)
      expect(launch).toHaveBeenCalledTimes(2)
    } finally {
      await session.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
