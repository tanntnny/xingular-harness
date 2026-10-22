// What a page in the harness's browser may reach. The same rule as `web_fetch`: public addresses
// only, unless a person allowed private ones for local development. This filters the browser's
// requests; it is a guard, not a sandbox (a page's own DNS can still differ from ours).
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { isPublicAddress } from '../web/safeRequest'
import type { BrowserConfig } from './config'

const OPEN_SCHEMES = new Set(['data:', 'blob:', 'about:'])
const CACHE_MS = 60_000

export class NetworkPolicy {
  private readonly hosts = new Map<string, { at: number; ok: boolean }>()

  constructor(private readonly config: () => BrowserConfig, private readonly resolve: (host: string) => Promise<string[]> = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address)) {}

  /** Why an address may not be loaded, or null when it may. */
  async refusal(address: string): Promise<string | null> {
    let url: URL
    try {
      url = new URL(address)
    } catch {
      return 'That is not a web address.'
    }
    if (OPEN_SCHEMES.has(url.protocol)) return null
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return `${url.protocol} addresses cannot be opened.`
    if (url.username || url.password) return 'Addresses with a username or password cannot be opened.'
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    const { allowedDomains, allowPrivate } = this.config()
    if (allowedDomains.length && !allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))) return `${host} is not among the sites this browser may reach.`
    if (allowPrivate) return null
    return (await this.isPublic(host)) ? null : `${host} is not a public address. A person can allow private addresses in the browser settings.`
  }

  private async isPublic(host: string): Promise<boolean> {
    if (isIP(host)) return isPublicAddress(host)
    if (host === 'localhost' || host.endsWith('.localhost')) return false
    const cached = this.hosts.get(host)
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.ok
    let ok = false
    try {
      const addresses = await this.resolve(host)
      ok = addresses.length > 0 && addresses.every(isPublicAddress)
    } catch {
      ok = false
    }
    this.hosts.set(host, { at: Date.now(), ok })
    return ok
  }
}
