// Web search behind one interface. Providers are tried in a fixed order, skipping those with no
// key; a provider that answers "too many requests" rests for as long as it asks and the next one
// answers instead. The keyless one reads a public results page and is used only when a person
// switched it on.
import { parseHTML } from 'linkedom'

import { secretKey, type SecretStore } from '../accounts/secrets'
import { logDiagnostic } from '../core/bus'
import { decodeBody, webAddress, type WebRequest } from './safeRequest'

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

export interface SearchProvider {
  id: string
  title: string
  /** The secret holding its key, or null for one that needs none. */
  key: string | null
  search(query: string, count: number, key: string | null, request: WebRequest): Promise<SearchHit[]>
}

/** Raised when a provider asks to be left alone; `retryAfterMs` comes from its answer. */
export class RateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super('The search service reached its request limit.')
  }
}

const TIMEOUT_MS = 15_000
const SEARCH_BYTES = 512 * 1024
const DEFAULT_COOLDOWN_MS = 60_000

/** Text of a snippet that may carry markup and entities. */
const clean = (text: unknown): string => (typeof text === 'string' && text ? (parseHTML(`<!doctype html><html><body><p>${text}</p></body></html>`).document.body.textContent ?? '').replace(/\s+/g, ' ').trim() : '')

function hit(title: unknown, address: unknown, snippet: unknown): SearchHit[] {
  if (typeof address !== 'string') return []
  try {
    return [{ title: clean(title), url: webAddress(address).href, snippet: clean(snippet) }]
  } catch {
    return []
  }
}

function retryAfter(headerless: number, body: string): number {
  const seconds = Number(/"retry[_-]?after"\s*:\s*(\d+)/i.exec(body)?.[1])
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : headerless
}

async function json(request: WebRequest, url: URL, init: { headers?: Record<string, string>; json?: unknown }): Promise<unknown> {
  const page = await request(url, { ...init, timeoutMs: TIMEOUT_MS, maxBytes: SEARCH_BYTES })
  const body = page.body.toString('utf8')
  if (page.status === 429) throw new RateLimited(retryAfter(DEFAULT_COOLDOWN_MS, body))
  if (page.status === 401 || page.status === 403) throw new Error('The search service refused the saved key.')
  if (page.status !== 200) throw new Error(`The search service answered with status ${page.status}.`)
  return JSON.parse(body)
}

export const BRAVE: SearchProvider = {
  id: 'brave',
  title: 'Brave Search',
  key: secretKey('_shared', 'web-search-key'),
  async search(query, count, key, request) {
    const url = new URL('https://api.search.brave.com/res/v1/web/search')
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(count))
    const parsed = await json(request, url, { headers: { 'x-subscription-token': key ?? '', accept: 'application/json' } }) as { web?: { results?: { title?: unknown; url?: unknown; description?: unknown }[] } }
    return (parsed.web?.results ?? []).flatMap((entry) => hit(entry.title, entry.url, entry.description))
  }
}

export const TAVILY: SearchProvider = {
  id: 'tavily',
  title: 'Tavily',
  key: secretKey('_shared', 'tavily-key'),
  async search(query, count, key, request) {
    const parsed = await json(request, new URL('https://api.tavily.com/search'), { headers: { authorization: `Bearer ${key ?? ''}` }, json: { query, max_results: count } }) as { results?: { title?: unknown; url?: unknown; content?: unknown }[] }
    return (parsed.results ?? []).flatMap((entry) => hit(entry.title, entry.url, entry.content))
  }
}

export const EXA: SearchProvider = {
  id: 'exa',
  title: 'Exa',
  key: secretKey('_shared', 'exa-key'),
  async search(query, count, key, request) {
    const parsed = await json(request, new URL('https://api.exa.ai/search'), { headers: { 'x-api-key': key ?? '' }, json: { query, numResults: count, contents: { highlights: { numSentences: 2 } } } }) as { results?: { title?: unknown; url?: unknown; highlights?: unknown[]; text?: unknown }[] }
    return (parsed.results ?? []).flatMap((entry) => hit(entry.title, entry.url, Array.isArray(entry.highlights) ? entry.highlights.join(' ') : entry.text))
  }
}

/** DuckDuckGo's plain results page. No key; off unless a person switched it on. */
export const DUCKDUCKGO: SearchProvider = {
  id: 'duckduckgo',
  title: 'DuckDuckGo (no key)',
  key: null,
  async search(query, count, _key, request) {
    const url = new URL('https://html.duckduckgo.com/html/')
    url.searchParams.set('q', query)
    const page = await request(url, { timeoutMs: TIMEOUT_MS, maxBytes: 2 * SEARCH_BYTES })
    if (page.status === 429 || page.status === 202) throw new RateLimited(DEFAULT_COOLDOWN_MS)
    if (page.status !== 200) throw new Error(`DuckDuckGo answered with status ${page.status}.`)
    const { document } = parseHTML(decodeBody(page.body, page.contentType))
    return [...document.querySelectorAll('.result')].flatMap((result) => {
      const link = result.querySelector('a.result__a')
      let address = link?.getAttribute('href') ?? ''
      // Results link through DuckDuckGo; the real address is the `uddg` parameter.
      try {
        const wrapped = new URL(address, 'https://duckduckgo.com')
        address = wrapped.searchParams.get('uddg') ?? wrapped.href
      } catch {
        return []
      }
      return hit(link?.textContent, address, result.querySelector('.result__snippet')?.textContent)
    }).slice(0, count)
  }
}

export const SEARCH_PROVIDERS: readonly SearchProvider[] = [BRAVE, TAVILY, EXA, DUCKDUCKGO]

export interface SearchOptions {
  secrets: SecretStore
  request: WebRequest
  /** Whether the keyless provider may be used. */
  keyless: () => boolean
  providers?: readonly SearchProvider[]
  now?: () => number
}

export interface SearchAnswer {
  provider: string | null
  results: SearchHit[]
  /** Why each provider tried did not answer, for the model and the log. */
  failures: string[]
}

/** Tries each usable provider in turn. Remembers which ones are resting. */
export class Searcher {
  private readonly resting = new Map<string, number>()

  constructor(private readonly options: SearchOptions) {}

  /** Providers that could answer now: a key saved (or none needed and allowed), not resting. */
  async usable(): Promise<{ provider: SearchProvider; key: string | null }[]> {
    const now = (this.options.now ?? Date.now)()
    const out: { provider: SearchProvider; key: string | null }[] = []
    for (const provider of this.options.providers ?? SEARCH_PROVIDERS) {
      if ((this.resting.get(provider.id) ?? 0) > now) continue
      if (provider.key === null) {
        if (this.options.keyless()) out.push({ provider, key: null })
        continue
      }
      const key = await this.options.secrets.get(provider.key)
      if (key) out.push({ provider, key })
    }
    return out
  }

  async search(query: string, count: number): Promise<SearchAnswer> {
    const failures: string[] = []
    const usable = await this.usable()
    for (const { provider, key } of usable) {
      try {
        return { provider: provider.id, results: (await provider.search(query, count, key, this.options.request)).slice(0, count), failures }
      } catch (error) {
        if (error instanceof RateLimited) this.resting.set(provider.id, (this.options.now ?? Date.now)() + error.retryAfterMs)
        const message = error instanceof Error ? error.message : String(error)
        failures.push(`${provider.title}: ${message}`)
        logDiagnostic('web_search provider failed', error, { provider: provider.id })
      }
    }
    if (!usable.length) failures.push('No search service is set up: save a Brave, Tavily or Exa key, or switch on keyless search.')
    return { provider: null, results: [], failures }
  }
}

/** Several queries' results interleaved, each address once, at most `limit`. */
export function mergeResults(lists: readonly SearchHit[][], limit: number): SearchHit[] {
  const seen = new Set<string>()
  const merged: SearchHit[] = []
  for (let round = 0; merged.length < limit && lists.some((list) => round < list.length); round += 1) {
    for (const list of lists) {
      const entry = list[round]
      if (!entry || seen.has(entry.url)) continue
      seen.add(entry.url)
      merged.push(entry)
      if (merged.length >= limit) break
    }
  }
  return merged
}
