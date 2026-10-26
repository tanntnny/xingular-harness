// A small, bounded read of a provider's own usage endpoint. It sends only the account's resolved
// credential, never a body, never follows a redirect elsewhere, and never puts a credential in an
// error message.
import { scrub } from '../../accounts/store'
import type { FetchLike } from './types'

const MAX_BODY = 200_000
const TIMEOUT_MS = 5_000

export interface JsonReading {
  status: number
  body: unknown
}

function allowed(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'))
  } catch {
    return false
  }
}

export async function getJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>, signal: AbortSignal): Promise<JsonReading> {
  if (!allowed(url)) throw new Error('The provider endpoint is not an HTTPS address.')
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const combined = typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout
  const response = await fetchImpl(url, { headers, signal: combined, redirect: 'error' })
  const text = (await response.text()).slice(0, MAX_BODY)
  if (!text.trim()) return { status: response.status, body: null }
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    throw new Error(scrub(`The provider returned an unreadable response (${response.status}).`))
  }
}

/** The headers a provider endpoint needs, from the credential Pi resolved. */
export function authHeaders(auth: { apiKey?: string; headers?: Record<string, string | null> }): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(auth.headers ?? {})) if (typeof value === 'string' && value) headers[key] = value
  if (auth.apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === 'authorization' || key.toLowerCase() === 'x-api-key')) {
    headers.authorization = `Bearer ${auth.apiKey}`
  }
  return headers
}

export function failure(status: number, provider: string): string {
  if (status === 401 || status === 403) return `The ${provider} credential cannot read usage limits (a key with more access is required).`
  if (status === 404) return `The ${provider} usage endpoint is not available at this address.`
  if (status === 429) return `The ${provider} usage endpoint is rate limited. Try again later.`
  return `The ${provider} usage endpoint returned ${status}.`
}
