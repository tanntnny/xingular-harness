// Reads a web address on behalf of an agent without reaching the machine's own network. The
// address is checked before a request and again when the connection is made, so a name that
// resolves to a private address, or changes between the check and the connection, is refused.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'

export interface WebResponse {
  status: number
  contentType: string
  body: Buffer
  /** The body reached the byte limit and was cut short. */
  truncated: boolean
  /** The address finally read, after any redirects. */
  url: URL
}

export interface WebRequestOptions {
  headers?: Record<string, string>
  /** Longest a single read may stay silent, and the most time the whole request may take. */
  timeoutMs: number
  maxBytes: number
  maxRedirects?: number
}

/** Makes one read. Tests replace it; the default is `safeRequest`. */
export type WebRequest = (url: URL, options: WebRequestOptions) => Promise<WebResponse>

const USER_AGENT = 'Mozilla/5.0 (compatible; XingularHarness/0.1; +web tools)'
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])

/** Only plain web addresses: no other scheme, and no username or password in the address. */
export function webAddress(input: string): URL {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('That is not a web address.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https addresses can be read.')
  if (url.username || url.password) throw new Error('Addresses with a username or password cannot be read.')
  if (!url.hostname) throw new Error('That address has no host name.')
  return url
}

/** Whether an address belongs to this machine, a private network, or is otherwise not public. */
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return isPublicIpv4(mapped[1])
  if (address.includes(':')) return isPublicIpv6(address.toLowerCase())
  return isPublicIpv4(address)
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b, c] = parts
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && c === 0) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  return true
}

function isPublicIpv6(address: string): boolean {
  // Global unicast only (2000::/3), without documentation (2001:db8::/32), Teredo (2001::/32) or 6to4 (2002::/16), which carry IPv4 addresses.
  const first = parseInt(address.split(':')[0] || '0', 16)
  if (Number.isNaN(first) || first < 0x2000 || first > 0x3fff) return false
  if (/^2001:db8(:|$)/.test(address) || /^2001:0{0,4}:/.test(address) || /^2002(:|$)/.test(address)) return false
  return true
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

/** A DNS lookup that refuses any address that is not public. It runs when the connection is made. */
function publicLookupImpl(hostname: string, options: { all?: boolean }, callback: LookupCallback): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error, '', 4)
    if (addresses.some((entry) => !isPublicAddress(entry.address))) {
      return callback(Object.assign(new Error(`${hostname} is not a public address.`), { code: 'EPRIVATE' }), '', 4)
    }
    if (options.all) return callback(null, addresses)
    callback(null, addresses[0].address, addresses[0].family)
  })
}

export const publicLookup = publicLookupImpl as unknown as LookupFunction

/**
 * A literal address is never looked up, so it is checked here. A name is checked by the lookup
 * at connection time.
 */
function assertReachable(url: URL): void {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && !isPublicAddress(host)) throw Object.assign(new Error(`${host} is not a public address.`), { code: 'EPRIVATE' })
}

/** Reads a web address, following redirects one at a time, each checked the same way. */
export const safeRequest: WebRequest = async (start, options) => {
  let url = start
  for (let hop = 0; ; hop += 1) {
    assertReachable(url)
    const response = await readOnce(url, options)
    if (REDIRECT_CODES.has(response.status) && response.location) {
      if (hop >= (options.maxRedirects ?? 5)) throw new Error('The address redirected too many times.')
      url = webAddress(new URL(response.location, url).toString())
      continue
    }
    return { status: response.status, contentType: response.contentType, body: response.body, truncated: response.truncated, url }
  }
}

function readOnce(url: URL, options: WebRequestOptions): Promise<WebResponse & { location?: string }> {
  return new Promise((resolve, reject) => {
    const start = (url.protocol === 'https:' ? httpsRequest : httpRequest) as typeof httpRequest
    let settled = false
    const finish = (value: WebResponse & { location?: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(total)
      resolve(value)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(total)
      reject(error)
    }
    const request = start(url, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5', ...options.headers },
      lookup: publicLookup,
      timeout: options.timeoutMs
    }, (response: IncomingMessage) => {
      const status = response.statusCode ?? 0
      const location = response.headers.location
      if (REDIRECT_CODES.has(status) && location) {
        response.resume()
        finish({ status, contentType: '', body: Buffer.alloc(0), truncated: false, url, location })
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      let truncated = false
      const done = (): void => finish({ status, contentType: String(response.headers['content-type'] ?? ''), body: Buffer.concat(chunks), truncated, url })
      response.on('data', (chunk: Buffer) => {
        const room = options.maxBytes - size
        const kept = chunk.length > room ? chunk.subarray(0, Math.max(room, 0)) : chunk
        chunks.push(kept)
        size += kept.length
        if (kept.length < chunk.length) {
          truncated = true
          response.destroy()
          done()
        }
      })
      response.on('error', (error) => (truncated ? done() : fail(error)))
      response.on('end', done)
      response.on('close', done)
    })
    // The whole request is capped as well as each silent stretch, so a slow trickle cannot hold a turn open.
    const total = setTimeout(() => request.destroy(new Error('The address took too long to answer.')), options.timeoutMs * 3)
    request.on('timeout', () => request.destroy(new Error('The address took too long to answer.')))
    request.on('error', fail)
    request.end()
  })
}
