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

  it('captures and resolves an empty element through a unique class-aware selector', async (context) => {
    if (!browser) context.skip()
    await page.setContent('<main><div class="empty-space panel" style="width:120px;height:40px"></div><div class="empty-space panel" style="width:120px;height:40px"></div><section><div style="width:120px;height:40px"></div></section></main>')
    type Next = { active: boolean; result: null | { action: string; body: string; target: { kind: string; tag?: string; name?: string; text?: string; selector?: string } } }
    await run({ operation: 'begin', kind: 'inspect', captureId: 'blank' })
    await page.locator('.empty-space').nth(1).click()
    await page.keyboard.type('Reduce this empty panel spacing')
    await page.keyboard.press('Control+Enter')
    const target = (await run<Next>({ operation: 'next', captureId: 'blank' })).result!.target
    expect(target).toMatchObject({ kind: 'element', tag: 'div', name: '', text: '' })
    expect(target.selector).toContain('.empty-space')
    expect(await page.locator(target.selector!).count()).toBe(1)
    expect(validateTarget(target)).toEqual(target)
    expect(await run<{ state: string }>({ operation: 'resolve', target })).toEqual({ state: 'matched' })

    await page.locator('section > div').click()
    await page.keyboard.type('Keep this empty region aligned')
    await page.keyboard.press('Control+Enter')
    const structural = (await run<Next>({ operation: 'next', captureId: 'blank' })).result!.target
    expect(structural).toMatchObject({ kind: 'element', tag: 'div', name: '', text: '' })
    expect(structural.selector).toContain('>')
    expect(await page.locator(structural.selector!).count()).toBe(1)
    expect(validateTarget(structural)).toEqual(structural)
    expect(await run<{ state: string }>({ operation: 'resolve', target: structural })).toEqual({ state: 'matched' })
    await run({ operation: 'cancel', captureId: 'blank' })
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

// Sites built from web components (reddit's shreddit-* elements) keep their content in open shadow roots.
describe('the page helper inside web components', () => {
  type Target = { kind: string; tag?: string; name?: string; text?: string; context?: string; exact?: string; tree?: string }
  type Next = { active: boolean; result: null | { action: string; body: string; target: Target } }
  const feed = async (): Promise<void> => {
    await page.setContent('<main><h1>Feed</h1><x-post id="a"><span slot="title">First post title</span></x-post><x-post id="b"><span slot="title">Second post title</span></x-post><x-locked id="locked">Unslotted light text</x-locked><p id="light">Plain light paragraph.</p></main>')
    await page.evaluate(() => {
      const doc = (globalThis as any).document
      // The page keeps its script state between tests: undo an earlier test's patch first.
      const native = ((globalThis as any).nativeAttachShadow ??= (globalThis as any).Element.prototype.attachShadow)
      ;(globalThis as any).Element.prototype.attachShadow = native
      for (const id of ['a', 'b']) {
        const root = doc.getElementById(id).attachShadow({ mode: 'open' })
        root.innerHTML = '<article><h2><slot name="title"></slot></h2><p class="body">Body of post ' + id + ' with a quick fox.</p>' +
          '<div class="scroller" style="height:40px;overflow:auto"><p style="height:200px">Scrolled area</p></div>' +
          '<button>Share</button><x-inner></x-inner><input type="password" value="hunter2"><p class="after">After the field.</p></article>'
        root.querySelector('x-inner').attachShadow({ mode: 'open' }).innerHTML = '<em>Nested note in ' + id + '</em>'
      }
      doc.getElementById('locked').attachShadow({ mode: 'closed' }).innerHTML = '<b>Private inside</b>'
      // Test only: open the inspector's own closed root so its hint text can be read.
      ;(globalThis as any).Element.prototype.attachShadow = function (init: { mode: string }) { return native.call(this, { ...init, mode: 'open' }) }
    })
  }
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 6 })
    await page.mouse.up()
  }

  it('picks, saves and finds again elements inside open shadow roots', async (context) => {
    if (!browser) context.skip()
    await feed()
    await run({ operation: 'begin', kind: 'inspect', captureId: 's1' })
    await page.locator('#a button').click()
    await page.keyboard.type('Share should be a menu')
    await page.keyboard.press('Control+Enter')
    const share = (await run<Next>({ operation: 'next', captureId: 's1' })).result!
    expect(share.target).toMatchObject({ kind: 'element', tag: 'button', name: 'Share', tree: 'composed' })
    expect(share.target.context).toContain('Body of post a')
    expect(validateTarget(share.target)).toEqual(share.target)

    // The same control in the other post is told apart by what surrounds it.
    expect(await run<{ state: string }>({ operation: 'resolve', target: share.target })).toEqual({ state: 'matched' })
    expect(await run<{ state: string }>({ operation: 'resolve', target: { ...share.target, context: '' } })).toMatchObject({ state: 'ambiguous' })

    // Slotted light content and a nested component are reachable too.
    await page.locator('#b span[slot=title]').click()
    await page.keyboard.type('Title')
    await page.keyboard.press('Control+Enter')
    expect((await run<Next>({ operation: 'next', captureId: 's1' })).result!.target).toMatchObject({ tag: 'span', text: 'Second post title', tree: 'composed' })
    await page.locator('#a x-inner em').click()
    await page.keyboard.type('Nested')
    await page.keyboard.press('Control+Enter')
    expect((await run<Next>({ operation: 'next', captureId: 's1' })).result!.target).toMatchObject({ tag: 'em', text: 'Nested note in a' })
    await run({ operation: 'cancel', captureId: 's1' })

    expect(await run<{ state: string }>({ operation: 'reveal', target: share.target })).toEqual({ state: 'matched' })
    expect(await page.locator('[data-harness-annotation-overlay]').count()).toBe(1)
  }, 60_000)

  it('captures text inside and across shadow roots, and refuses selections over a field', async (context) => {
    if (!browser) context.skip()
    await feed()
    const body = (await page.locator('#a p.body').boundingBox())!
    await run({ operation: 'begin', kind: 'text', captureId: 't1' })
    await drag({ x: body.x + 1, y: body.y + body.height / 2 }, { x: body.x + body.width - 2, y: body.y + body.height / 2 })
    const inside = await run<{ target: Target }>({ operation: 'capture', captureId: 't1' })
    expect(inside.target).toMatchObject({ kind: 'text', tree: 'composed' })
    expect(inside.target.exact).toMatch(/^Body of post a with a quick fox/)
    expect(validateTarget(inside.target)).toEqual(inside.target)
    expect(await run<{ state: string }>({ operation: 'reveal', target: inside.target })).toEqual({ state: 'matched' })
    expect(await page.locator('[data-harness-annotation-overlay] div').count()).toBeGreaterThan(0)

    // From light text into a component.
    const heading = (await page.locator('h1').boundingBox())!
    const title = (await page.locator('#a span[slot=title]').boundingBox())!
    await run({ operation: 'begin', kind: 'text', captureId: 't2' })
    await drag({ x: heading.x + 1, y: heading.y + heading.height / 2 }, { x: title.x + title.width - 2, y: title.y + title.height / 2 })
    const across = await run<{ target: Target }>({ operation: 'capture', captureId: 't2' })
    expect(across.target.exact).toBe('Feed First post title')
    expect(await run<{ state: string }>({ operation: 'resolve', target: across.target })).toEqual({ state: 'matched' })

    // Across the password field inside post a: refused, not captured partially.
    const after = (await page.locator('#a p.after').boundingBox())!
    await run({ operation: 'begin', kind: 'text', captureId: 't3' })
    await drag({ x: body.x + 1, y: body.y + body.height / 2 }, { x: after.x + after.width - 2, y: after.y + after.height / 2 })
    expect(await run({ operation: 'capture', captureId: 't3' })).toBeNull()
    await run({ operation: 'cancel', captureId: 't3' })
  }, 60_000)

  it('explains what it refuses: fields and closed components', async (context) => {
    if (!browser) context.skip()
    await feed()
    await run({ operation: 'begin', kind: 'inspect', captureId: 'r1' })
    const hint = async (): Promise<string> => page.evaluate(() => {
      const host = (globalThis as any).document.querySelector('[data-harness-annotation-overlay]')
      return host?.shadowRoot?.querySelector('.chip.refused')?.textContent ?? ''
    })
    await page.locator('#a input').hover()
    await page.mouse.move(...(await page.locator('#a input').boundingBox().then(box => [box!.x + 3, box!.y + 3] as const)))
    await page.waitForTimeout(80)
    expect(await hint()).toMatch(/Form fields and private content/)
    await page.locator('#locked').hover()
    await page.waitForTimeout(80)
    expect(await hint()).toMatch(/contents are private/)
    // Clicking either opens nothing.
    await page.locator('#locked').click()
    await page.keyboard.type('nope')
    await page.keyboard.press('Control+Enter')
    expect((await run<Next>({ operation: 'next', captureId: 'r1' })).result).toBeNull()
    await run({ operation: 'cancel', captureId: 'r1' })
  }, 60_000)

  it('keeps notes saved before composed support exactly as they were', async (context) => {
    if (!browser) context.skip()
    await page.setContent('<main><h1>Title</h1><p id="p">The quick brown fox jumps.</p><p>Another fox here.</p><button aria-label="Save draft">Save</button></main>')
    const select = async (): Promise<void> => {
      await page.evaluate(() => {
        const node = (globalThis as any).document.getElementById('p').firstChild
        const range = (globalThis as any).document.createRange()
        range.setStart(node, 4)
        range.setEnd(node, 15)
        const selection = (globalThis as any).getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
      })
    }
    await run({ operation: 'begin', kind: 'text', captureId: 'l1' })
    await select()
    const composed = (await run<{ target: Target }>({ operation: 'capture', captureId: 'l1' })).target
    // Without getComposedRanges the helper falls back to the document-only capture.
    await page.evaluate(() => { delete (globalThis as any).Selection.prototype.getComposedRanges })
    await run({ operation: 'begin', kind: 'text', captureId: 'l2' })
    await select()
    const legacy = (await run<{ target: Target }>({ operation: 'capture', captureId: 'l2' })).target
    expect(legacy.tree).toBeUndefined()
    // On a page without components both walks read the same text, so positions and context agree.
    const { tree, ...rest } = composed
    expect(tree).toBe('composed')
    expect(rest).toEqual(legacy)
    expect(await run<{ state: string }>({ operation: 'resolve', target: legacy })).toEqual({ state: 'matched' })
    expect(await run<{ state: string }>({ operation: 'resolve', target: { kind: 'element', tag: 'button', role: 'button', name: 'Save draft', text: 'Save', context: '', selector: 'button' } })).toEqual({ state: 'matched' })
    expect(() => validateTarget({ ...legacy, tree: 'flat' })).toThrow()
  }, 60_000)
})
