// Runs the page helper in an isolated script world of a Chromium page (PROP-0018): the DOM is the
// page's, the JavaScript globals are not, so the page's own scripts cannot read or fake the
// inspector's results. Where no DevTools session is available (another engine, a test double),
// it falls back to the page's own world and says the result is untrusted.
import type { CDPSession, Page } from 'playwright-core'

const WORLD = 'harness-page-notes'

interface World {
  cdp: CDPSession
  contextId: number
}

const worlds = new WeakMap<Page, World>()
const watched = new WeakSet<Page>()

async function createWorld(page: Page): Promise<World> {
  const cdp = await page.context().newCDPSession(page)
  const { frameTree } = await cdp.send('Page.getFrameTree') as { frameTree: { frame: { id: string } } }
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: WORLD, grantUniveralAccess: false }) as { executionContextId: number }
  const world = { cdp, contextId: executionContextId }
  worlds.set(page, world)
  if (!watched.has(page)) {
    watched.add(page)
    // A new document destroys the world; the next call makes another.
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      const old = worlds.get(page)
      worlds.delete(page)
      void old?.cdp.detach().catch(() => undefined)
    })
  }
  return world
}

/** Evaluates `expression` (which yields a JSON string) and says whether the page could have reached it. */
export async function evaluateIsolated(page: Page, expression: string): Promise<{ reply: unknown; trusted: boolean }> {
  if (typeof page.context !== 'function' || typeof page.context().newCDPSession !== 'function') {
    return { reply: await page.evaluate(expression), trusted: false }
  }
  let lastError: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    let world = worlds.get(page) ?? null
    try {
      world ??= await createWorld(page)
      const evaluated = await world.cdp.send('Runtime.evaluate', { expression, contextId: world.contextId, returnByValue: true, awaitPromise: false }) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
      if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text || 'The page helper failed.')
      return { reply: evaluated.result?.value, trusted: true }
    } catch (error) {
      lastError = error
      worlds.delete(page)
      void world?.cdp.detach().catch(() => undefined)
      // A context that went away with a navigation is made again once; anything else falls back.
      if (attempt === 0 && /context|target closed|detached/i.test(String(error))) continue
      break
    }
  }
  if (/closed/i.test(String(lastError))) throw lastError
  return { reply: await page.evaluate(expression), trusted: false }
}
