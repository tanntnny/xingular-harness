import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright-core'

import { pageCall, pageReply } from './pageScript'
import { validateTarget } from './store'

// The helper runs in a real page. Without a local Chrome or Playwright Chromium the test is skipped.
let browser: Browser | null = null
let page: Page
beforeAll(async () => {
  const { chromium } = await import('playwright-core')
  for (const attempt of [{ channel: 'chrome' }, {}]) {
    try {
      browser = await chromium.launch({ headless: true, ...attempt })
      break
    } catch {
      browser = null
    }
  }
  if (browser) page = await browser.newPage()
}, 60_000)
afterAll(async () => { await browser?.close() })

const run = async <T>(operation: Parameters<typeof pageCall>[0]): Promise<T> => pageReply<T>(await page.evaluate(pageCall(operation)))

describe('the page helper in a real page', () => {
  it('captures selected text and an element the person clicks, and reveals them again', async (context) => {
    if (!browser) context.skip()
    await page.setContent('<main><h1>Title</h1><p id="p">The quick brown fox jumps.</p><p>Another fox here.</p><button aria-label="Save draft">Save</button><input type="password" value="secret"></main>')

    const identity = await run<{ url: string; documentId: string }>({ operation: 'identity' })
    expect(identity.documentId).toMatch(/[0-9a-f-]{36}/)

    const text = await run<null>({ operation: 'begin', kind: 'text', captureId: 'c1' })
    expect(text).toBeNull()
    await page.evaluate(() => {
      const node = (globalThis as any).document.getElementById('p').firstChild
      const range = (globalThis as any).document.createRange()
      range.setStart(node, 4)
      range.setEnd(node, 15)
      const selection = (globalThis as any).getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
    })
    const captured = await run<{ target: { kind: string; exact: string } }>({ operation: 'capture', captureId: 'c1' })
    expect(captured.target).toMatchObject({ kind: 'text', exact: 'quick brown' })
    // What the page returned passes the store's own checks.
    expect(validateTarget(captured.target)).toEqual(captured.target)
    expect(await run<{ state: string }>({ operation: 'reveal', target: captured.target })).toEqual({ state: 'matched' })
    expect(await page.locator('[data-harness-annotation-overlay]').count()).toBe(1)

    await run({ operation: 'begin', kind: 'element', captureId: 'c2' })
    await page.click('button')
    const element = await run<{ target: { kind: string; name: string; role: string } }>({ operation: 'capture', captureId: 'c2' })
    expect(element.target).toMatchObject({ kind: 'element', tag: 'button', role: 'button', name: 'Save draft' })

    const ambiguous = { kind: 'text', exact: 'fox', prefix: '', suffix: '', start: 0, end: 3 }
    expect(await run<{ state: string }>({ operation: 'resolve', target: ambiguous })).toMatchObject({ state: 'ambiguous' })
    expect(await run<{ state: string }>({ operation: 'resolve', target: { ...ambiguous, exact: 'wolf' } })).toMatchObject({ state: 'unresolved' })
  }, 60_000)

  it('inspects: hover outlines, a click opens the popover, each comment waits for next', async (context) => {
    if (!browser) context.skip()
    await page.setContent('<main><h1>Title</h1><p id="p">The quick brown fox jumps.</p><button id="go" onclick="window.clicked=(window.clicked||0)+1">Save</button><input id="secret" type="password"></main>')
    type Next = { active: boolean; result: null | { action: string; body: string; target: { kind: string; tag?: string; exact?: string } } }
    await run({ operation: 'begin', kind: 'inspect', captureId: 'i1' })
    expect(await run<Next>({ operation: 'next', captureId: 'i1' })).toMatchObject({ active: true, result: null })

    // Clicking a component picks it; the page's own handler never runs.
    await page.click('#go')
    await page.waitForTimeout(50)
    expect(await page.evaluate(() => (globalThis as any).clicked ?? 0)).toBe(0)
    await page.keyboard.type('Make it primary')
    await page.keyboard.press('Control+Enter')
    const first = await run<Next>({ operation: 'next', captureId: 'i1' })
    expect(first.result).toMatchObject({ action: 'send', body: 'Make it primary', target: { kind: 'element', tag: 'button' } })
    expect(validateTarget(first.result!.target)).toEqual(first.result!.target)
    // Still on for the next pick; a result is returned once.
    expect(await run<Next>({ operation: 'next', captureId: 'i1' })).toMatchObject({ active: true, result: null })

    await page.click('h1')
    await page.keyboard.type('Bigger')
    await page.keyboard.press('Control+Shift+Enter')
    expect((await run<Next>({ operation: 'next', captureId: 'i1' })).result).toMatchObject({ action: 'queue', body: 'Bigger', target: { kind: 'element', tag: 'h1' } })

    // A drag over text opens the popover on the selection.
    const box = (await page.locator('#p').boundingBox())!
    await page.mouse.move(box.x + 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.type('Reword')
    await page.keyboard.press('Control+Enter')
    const text = (await run<Next>({ operation: 'next', captureId: 'i1' })).result
    expect(text?.target.kind).toBe('text')
    expect(text?.target.exact).toMatch(/^The quick/)

    // Sensitive fields are never picked; Escape closes an open popover without a result.
    await page.click('#secret')
    await page.keyboard.type('nope')
    expect((await run<Next>({ operation: 'next', captureId: 'i1' })).result).toBeNull()
    await page.click('h1')
    await page.keyboard.press('Escape')
    expect((await run<Next>({ operation: 'next', captureId: 'i1' })).result).toBeNull()

    await run({ operation: 'toast', text: 'Sent to the agent' })
    await run({ operation: 'cancel', captureId: 'i1' })
    expect(await run<Next>({ operation: 'next', captureId: 'i1' })).toMatchObject({ active: false })
    expect(await page.locator('[data-harness-annotation-overlay]').count()).toBe(0)
    await page.click('#go')
    expect(await page.evaluate(() => (globalThis as any).clicked)).toBe(1)
  }, 60_000)
})
