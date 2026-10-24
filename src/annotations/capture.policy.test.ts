import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import type { Browser, BrowserContext, Page } from 'playwright-core'

import { writeBrowserConfig } from '../browser/config'
import type { Launcher } from '../browser/session'
import { AnnotationCapture } from './capture'

function fakeLauncher() {
  let currentUrl = 'about:blank'
  const navigated: string[] = []
  const page = {
    on: () => undefined,
    url: () => currentUrl,
    goto: async (address: string) => { navigated.push(address); currentUrl = address },
    bringToFront: async () => undefined,
    title: async () => 'Local dev server'
  } as unknown as Page
  const context = {
    on: () => undefined,
    setDefaultTimeout: () => undefined,
    setDefaultNavigationTimeout: () => undefined,
    route: async () => undefined,
    pages: () => [],
    newPage: async () => page,
    close: async () => undefined
  } as unknown as BrowserContext
  const browser = { on: () => undefined, close: async () => undefined } as unknown as Browser
  const launch: Launcher = async () => ({ context, browser, attached: false })
  return { launch, navigated }
}

describe('annotation capture network policy', () => {
  it('blocks localhost by default and opens it when private addresses are enabled', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'harness-capture-policy-'))
    const address = 'http://localhost:5173/'
    const fake = fakeLauncher()
    const capture = new AnnotationCapture({ stateDir, launch: fake.launch })
    try {
      await expect(capture.open('s1', address)).rejects.toThrow('localhost is not a public address. A person can allow private addresses in the browser settings.')
      expect(fake.navigated).toEqual([])

      writeBrowserConfig(stateDir, { allowPrivate: true })
      expect(await capture.open('s1', address)).toEqual({ url: address, title: 'Local dev server' })
      expect(fake.navigated).toEqual([address])
    } finally {
      await capture.close()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
