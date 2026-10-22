// How the harness's browser runs, kept on this device: `<state dir>/browser.json`. Only a person
// (through a command or the application) writes it; no tool argument can point the browser at
// another endpoint or profile.
import { join } from 'node:path'

import { readJsonOr, writeJson } from '../core/fs'

export interface BrowserConfig {
  /** Show the browser window instead of running it headless. */
  headed: boolean
  /** Attach to a browser a person already runs (its DevTools address) instead of launching one. */
  cdpUrl: string | null
  /** A browser program to launch; otherwise Chrome, then Edge, then Playwright's Chromium. */
  executablePath: string | null
  /** Let pages reach this machine and private networks (local development servers). */
  allowPrivate: boolean
  /** When set, pages may only reach these sites (and their subdomains). */
  allowedDomains: string[]
}

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = { headed: false, cdpUrl: null, executablePath: null, allowPrivate: false, allowedDomains: [] }

export const configPath = (stateDir: string): string => join(stateDir, 'browser.json')

export function readBrowserConfig(stateDir: string): BrowserConfig {
  const saved = readJsonOr<Partial<BrowserConfig>>(configPath(stateDir), {})
  return {
    headed: saved.headed === true,
    cdpUrl: typeof saved.cdpUrl === 'string' && /^(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/.test(saved.cdpUrl) ? saved.cdpUrl : null,
    executablePath: typeof saved.executablePath === 'string' && saved.executablePath.trim() ? saved.executablePath : null,
    allowPrivate: saved.allowPrivate === true,
    allowedDomains: Array.isArray(saved.allowedDomains) ? saved.allowedDomains.filter((domain): domain is string => typeof domain === 'string' && /^[a-z0-9.-]+$/i.test(domain)).map((domain) => domain.toLowerCase()) : []
  }
}

export function writeBrowserConfig(stateDir: string, change: Partial<BrowserConfig>): BrowserConfig {
  const next = { ...readBrowserConfig(stateDir), ...change }
  writeJson(configPath(stateDir), next)
  return readBrowserConfig(stateDir)
}
