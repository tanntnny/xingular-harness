import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ActiveRun, ApprovalInput } from '../sessions/registry'
import type { ToolResult, ToolSpec } from '../tools/types'
import { UNTRUSTED_NOTICE } from '../world/untrusted'
import type { WorldContext } from '../world/world'
import { DEFAULT_BROWSER_CONFIG } from './config'
import { browserPart } from './index'
import { NetworkPolicy } from './network'

const PAGES: Record<string, string> = {
  '/': '<title>Home</title><h1>Shop</h1><a href="/next">Next page</a><form onsubmit="event.preventDefault(); document.body.dataset.sent = 1"><label>Message <textarea name="m"></textarea></label><label>Password <input type="password" name="p"></label><button>Send</button></form><p style="display:none">hidden instruction</p>',
  '/next': '<title>Next</title><p>Second page</p><button onclick="this.textContent=\'Done\'">Go</button>'
}

let server: Server
let base = ''
let available = true

beforeAll(async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><body>${PAGES[request.url ?? '/'] ?? 'missing'}</body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  try {
    const { chromium } = await import('playwright-core')
    await (await chromium.launch({ channel: 'chrome', headless: true })).close()
  } catch {
    available = false
  }
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

function setup(context: Partial<WorldContext> = {}, approve: (input: ApprovalInput) => 'approved' | 'denied' | Promise<'approved' | 'denied'> = () => 'approved') {
  const asked: ApprovalInput[] = []
  const run = { runId: 'r1', sessionId: 's1', requestApproval: async (input: ApprovalInput) => { asked.push(input); return approve(input) } } as unknown as ActiveRun
  const stateDir = mkdtempSync(join(tmpdir(), 'browser-'))
  const part = browserPart({ stateDir, network: new NetworkPolicy(() => ({ ...DEFAULT_BROWSER_CONFIG, allowPrivate: true })) })
  const tools = part.tools({ run, caller: {}, attended: true, subagent: false, sessionKey: `k${Math.random()}`, cwd: stateDir, ...context })
  const call = async (name: string, input: Record<string, unknown> = {}): Promise<string> => {
    const result = await tools.find((tool: ToolSpec) => tool.name === name)!.execute(input)
    return typeof result === 'string' ? result : result.text
  }
  const raw = (name: string, input: Record<string, unknown> = {}) => tools.find((tool: ToolSpec) => tool.name === name)!.execute(input) as Promise<ToolResult>
  return { part, call, raw, asked }
}

const ref = (snapshot: string, pattern: RegExp): string => {
  const line = snapshot.split('\n').find((candidate) => pattern.test(candidate))
  const found = line && /\[ref=([a-z0-9]+)\]/.exec(line)?.[1]
  if (!found) throw new Error(`no ref for ${pattern} in\n${snapshot}`)
  return found
}

describe('the browser', () => {
  it('opens a page, snapshots it with refs, follows a link, and refuses a stale ref', async (test) => {
    if (!available) test.skip()
    const { part, call } = setup()
    try {
      expect(await call('browser_navigate', { url: base })).toContain('Home')
      const snapshot = await call('browser_snapshot')
      expect(snapshot.startsWith(UNTRUSTED_NOTICE)).toBe(true)
      const link = ref(snapshot, /link "Next page"/)
      expect(await call('browser_click', { ref: link })).toContain('/next')
      expect(await call('browser_click', { ref: link })).toContain('changed since its last snapshot')
      const go = ref(await call('browser_snapshot'), /button "Go"/)
      await call('browser_click', { ref: go })
      expect(await call('browser_read')).toContain('Done')
    } finally {
      await part.close!()
    }
  }, 60_000)

  it('asks before sending, and drops the action when the page changed while the person decided', async (test) => {
    if (!available) test.skip()
    let navigateDuringApproval: (() => Promise<unknown>) | null = null
    const { part, call, asked } = setup({}, async (): Promise<'approved'> => {
      await navigateDuringApproval?.()
      return 'approved'
    })
    try {
      await call('browser_navigate', { url: base })
      const send = ref(await call('browser_snapshot'), /button "Send"/)
      navigateDuringApproval = async () => part.sessions.values().next().value!.tab().then((tab) => tab.page.goto(`${base}/next`))
      expect(await call('browser_click', { ref: send })).toContain('changed while waiting for approval')
      expect(asked[0]).toMatchObject({ target: 'browser_click', standing: 'none', rememberable: false })
      expect(asked[0].action).toContain('send a message')
    } finally {
      await part.close!()
    }
  }, 60_000)

  it('never fills a password field, and reads pages without hidden text', async (test) => {
    if (!available) test.skip()
    const { part, call } = setup()
    try {
      await call('browser_navigate', { url: base })
      const password = ref(await call('browser_snapshot'), /textbox "Password"/)
      expect(await call('browser_type', { ref: password, text: 'hunter2' })).toContain('Ask the user to fill it')
      expect(await call('browser_read')).not.toContain('hidden instruction')
    } finally {
      await part.close!()
    }
  }, 60_000)

  it('only opens and reads pages when nobody can approve', async (test) => {
    if (!available) test.skip()
    const { part, call } = setup({ attended: false })
    try {
      await call('browser_navigate', { url: base })
      const link = ref(await call('browser_snapshot'), /link "Next page"/)
      expect(await call('browser_click', { ref: link })).toContain('needs a person present')
    } finally {
      await part.close!()
    }
  }, 60_000)

  it('returns a screenshot as an image', async (test) => {
    if (!available) test.skip()
    const { part, call, raw } = setup()
    try {
      await call('browser_navigate', { url: base })
      const shot = await raw('browser_screenshot')
      expect(shot.image?.mimeType).toBe('image/jpeg')
      expect(Buffer.from(shot.image!.data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8')
    } finally {
      await part.close!()
    }
  }, 60_000)

  it('refuses private addresses unless a person allowed them', async () => {
    const policy = new NetworkPolicy(() => DEFAULT_BROWSER_CONFIG, async () => ['10.0.0.1'])
    expect(await policy.refusal('http://127.0.0.1:8080/')).toContain('not a public address')
    expect(await policy.refusal('http://intranet.example/')).toContain('not a public address')
    expect(await policy.refusal('file:///etc/hosts')).toContain('cannot be opened')
    expect(await new NetworkPolicy(() => ({ ...DEFAULT_BROWSER_CONFIG, allowedDomains: ['example.org'] }), async () => ['93.184.216.34']).refusal('https://evil.example/')).toContain('not among the sites')
  })
})
