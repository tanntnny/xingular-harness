import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import type { ToolSession, ToolSpec } from '../tools/types'
import { isPublicAddress, publicLookup, safeRequest, webAddress, type WebRequest, type WebResponse } from './safeRequest'
import { WEB_SEARCH_KEY, webTools } from './tools'
import { setLogSink } from '../core/bus'
import { htmlToText } from './text'

const session = {} as ToolSession

beforeEach(() => setLogSink(() => {}))
afterEach(() => setLogSink(null))

function tool(name: string, request?: WebRequest, secrets = memorySecretStore()): ToolSpec {
  const spec = webTools({ secrets, request })(session) as ToolSpec[]
  const found = spec.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`no ${name}`)
  return found
}

const response = (overrides: Partial<WebResponse> & { text?: string }): WebResponse => ({
  status: 200,
  contentType: 'text/html; charset=utf-8',
  body: Buffer.from(overrides.text ?? ''),
  truncated: false,
  url: new URL('https://example.com/page'),
  ...overrides
})

describe('address checks', () => {
  it('refuses this machine, private networks, link-local, and unique-local addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', 'ff02::1']) {
      expect(isPublicAddress(address), address).toBe(false)
    }
  })

  it('allows public IPv4 and global IPv6 addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
      expect(isPublicAddress(address), address).toBe(true)
    }
  })

  it('reads only http and https addresses without credentials', () => {
    expect(webAddress('https://glama.ai/mcp').href).toBe('https://glama.ai/mcp')
    expect(() => webAddress('file:///etc/hosts')).toThrow('Only http and https')
    expect(() => webAddress('https://user:secret@example.com/')).toThrow('username or password')
    expect(() => webAddress('not a url')).toThrow('not a web address')
  })

  it('refuses a name that resolves to a private address when the connection is made', async () => {
    await expect(safeRequest(new URL('http://127.0.0.1:9/'), { timeoutMs: 1000, maxBytes: 100 })).rejects.toThrow('not a public address')
    await expect(safeRequest(new URL('http://localhost:9/'), { timeoutMs: 1000, maxBytes: 100 })).rejects.toThrow('not a public address')
  })

  it('reports a refused address through the lookup callback', async () => {
    const error = await new Promise<Error | null>((resolve) => publicLookup('10.0.0.5', { all: false }, (failure) => resolve(failure)))
    expect(error?.message).toContain('not a public address')
  })
})

describe('page text', () => {
  it('keeps the readable text, drops scripts and styles, and decodes entities', () => {
    const html = '<html><head><title>T</title><style>p{color:red}</style></head><body><script>alert(1)</script><h1>Title &amp; more</h1><p>First&nbsp;paragraph.</p><p>Second</p></body></html>'
    const { text, truncated } = htmlToText(html, 1000)
    expect(text).toContain('Title & more')
    expect(text).toContain('First paragraph.')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('color:red')
    expect(truncated).toBe(false)
  })

  it('caps the text and marks it truncated', () => {
    const { text, truncated } = htmlToText(`<p>${'word '.repeat(100)}</p>`, 50)
    expect(text.length).toBe(50)
    expect(truncated).toBe(true)
  })
})

describe('web_search', () => {
  it('marks search and fetching as read-only research tools', () => {
    expect(tool('web_search').readOnly).toBe(true)
    expect(tool('web_fetch').readOnly).toBe(true)
  })

  it('says so, without asking the network, when no key is saved', async () => {
    let asked = false
    const result = await tool('web_search', async () => {
      asked = true
      return response({})
    }).execute({ query: 'mcp server' })
    expect(result).toContain('not set up')
    expect(asked).toBe(false)
  })

  it('sends the query with the saved key and returns clean results', async () => {
    const seen: { url: string; headers?: Record<string, string> }[] = []
    const request: WebRequest = async (url, options) => {
      seen.push({ url: url.toString(), headers: options.headers })
      return response({
        contentType: 'application/json',
        text: JSON.stringify({ web: { results: [
          { title: '<strong>glama</strong>.ai', url: 'https://glama.ai/mcp', description: 'Servers &amp; <strong>tools</strong>' },
          { title: 'Local', url: 'file:///x', description: 'not public' }
        ] } })
      })
    }
    const secrets = memorySecretStore({ [WEB_SEARCH_KEY]: 'key-123' })
    const result = JSON.parse(await tool('web_search', request, secrets).execute({ query: 'mcp server', count: 3 }) as string)
    expect(seen[0].url).toContain('q=mcp+server')
    expect(seen[0].url).toContain('count=3')
    expect(seen[0].headers?.['x-subscription-token']).toBe('key-123')
    expect(result.results).toEqual([{ title: 'glama.ai', url: 'https://glama.ai/mcp', snippet: 'Servers & tools' }])
  })

  it('explains a refused key or a spent limit in plain words', async () => {
    const secrets = memorySecretStore({ [WEB_SEARCH_KEY]: 'k' })
    expect(await tool('web_search', async () => response({ status: 401 }), secrets).execute({ query: 'x' })).toContain('refused the saved key')
    expect(await tool('web_search', async () => response({ status: 429 }), secrets).execute({ query: 'x' })).toContain('limit')
  })

  it('needs a query', async () => {
    expect(await tool('web_search', undefined, memorySecretStore({ [WEB_SEARCH_KEY]: 'k' })).execute({ query: '  ' })).toBe('Give a search query.')
  })
})

describe('web_fetch', () => {
  it('returns the title and text of a page', async () => {
    const page = tool('web_fetch', async () => response({ text: '<title>Glama</title><p>MCP servers</p>' }))
    const result = JSON.parse(await page.execute({ url: 'https://glama.ai/' }) as string)
    expect(result).toMatchObject({ title: 'Glama', text: 'MCP servers', status: 200, truncated: false })
  })

  it('records fetch failures with stack and safe request metadata', async () => {
    const lines: string[] = []
    setLogSink((text) => void lines.push(text))
    try {
      const page = tool('web_fetch', async () => { throw new Error('request failed for https://example.com/private?token=secret-value') })
      await page.execute({ url: 'https://example.com/path?key=secret-value' })
      expect(lines.join('\\n')).toContain('web_fetch failed')
      expect(lines.join('\\n')).toContain('"stack"')
      expect(lines.join('\\n')).toContain('"durationMs"')
      expect(lines.join('\\n')).toContain('https://example.com/path')
      expect(lines.join('\\n')).not.toContain('secret-value')
    } finally {
      setLogSink(null)
    }
  })

  it('does not read addresses with credentials', async () => {
    let asked = false
    const result = await tool('web_fetch', async () => {
      asked = true
      return response({})
    }).execute({ url: 'https://me:pw@example.com/' })
    expect(result).toContain('username or password')
    expect(asked).toBe(false)
  })

  it('reports a missing page and a non-text file instead of inventing content', async () => {
    const missing = JSON.parse(await tool('web_fetch', async () => response({ status: 404 })).execute({ url: 'https://example.com/x' }) as string)
    expect(missing.error).toContain('status 404')
    const image = JSON.parse(await tool('web_fetch', async () => response({ contentType: 'image/png' })).execute({ url: 'https://example.com/a.png' }) as string)
    expect(image.error).toContain('image/png')
  })
})
