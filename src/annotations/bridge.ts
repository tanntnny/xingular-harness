// The page bridge (PROP-0018): page notes in a web view that has no DevTools port, such as a Tauri
// window on macOS. The developer loads one script into their app while developing it; the script
// carries the page helper and pulls operations from this loopback server, answering each with the
// helper's JSON. Only 127.0.0.1 listens, every request carries the bridge token, and everything a
// window answers is untrusted page data.
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { readJson, writeJson } from '../core/fs'
import { PAGE_SCRIPT, type PageOperation } from './pageScript'

const POLL_MS = 20_000
const GONE_MS = 45_000
const CALL_MS = 10_000
const MAX_BODY = 1_000_000
const MAX_WINDOWS = 32

export interface BridgeWindow {
  id: string
  url: string
  title: string
  lastSeen: number
}

interface Pending {
  id: string
  operation: PageOperation
  resolve: (reply: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface Live extends BridgeWindow {
  queue: Pending[]
  sent: Map<string, Pending>
  waiter: ServerResponse | null
  waiterTimer: NodeJS.Timeout | null
}

export interface BridgeInfo {
  port: number
  token: string
  scriptUrl: string
  /** What to put in the app while developing it. */
  snippet: string
}

const bounded = (value: unknown, size: number): string => (typeof value === 'string' ? Array.from(value).slice(0, size).join('') : '')

/** The script a window loads: the page helper plus a loop that pulls operations from the bridge. */
export function bridgeScript(base: string, token: string): string {
  const helper = PAGE_SCRIPT.replace('__ARGS__', () => '__op')
  return `(() => {
  if (window.__harnessPageNotesBridge) return
  window.__harnessPageNotesBridge = true
  const base = ${JSON.stringify(base)}
  const token = ${JSON.stringify(token)}
  const call = (__op) => ${helper}
  let windowId = null
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ token, ...body }) })
    .then(response => response.ok ? response.json() : Promise.reject(new Error(String(response.status))))
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  const loop = async () => {
    for (;;) {
      try {
        if (!windowId) windowId = (await post('/register', { url: location.href, title: document.title })).windowId
        const query = '?token=' + encodeURIComponent(token) + '&window=' + encodeURIComponent(windowId) + '&url=' + encodeURIComponent(location.href.slice(0, 2000)) + '&title=' + encodeURIComponent(document.title.slice(0, 200))
        const response = await fetch(base + '/poll' + query)
        if (response.status === 410) { windowId = null; continue }
        if (response.status !== 200) { if (response.status !== 204) await pause(2000); continue }
        const { id, operation } = await response.json()
        let reply
        try { reply = call(operation) } catch (error) { reply = JSON.stringify({ ok: false, error: String(error && error.message || error) }) }
        await post('/reply', { window: windowId, id, reply })
      } catch {
        await pause(2000)
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loop, { once: true })
  else loop()
})()
`
}

export class NotesBridge {
  private server: Server | null = null
  private starting: Promise<BridgeInfo> | null = null
  private info: BridgeInfo | null = null
  private readonly windows = new Map<string, Live>()
  private nextWindow = 1
  private nextCall = 1

  constructor(private readonly options: { stateDir: string; port?: number }) {}

  private settingsFile(): string {
    return join(this.options.stateDir, 'notes-bridge.json')
  }

  /** Starts the bridge (once) on the port and token kept from last time, so the app's snippet stays valid. */
  start(): Promise<BridgeInfo> {
    if (this.info) return Promise.resolve(this.info)
    this.starting ??= this.listen().finally(() => { this.starting = null })
    return this.starting
  }

  private async listen(): Promise<BridgeInfo> {
    const settingsFile = this.settingsFile()
    if (existsSync(settingsFile)) chmodSync(settingsFile, 0o600)
    const saved = existsSync(settingsFile) ? readJson<{ port?: number; token?: string }>(settingsFile) : null
    const token = typeof saved?.token === 'string' && /^[a-f0-9]{48}$/.test(saved.token) ? saved.token : randomBytes(24).toString('hex')
    const wanted = this.options.port ?? (Number.isSafeInteger(saved?.port) ? saved!.port! : 0)
    const server = createServer((request, response) => void this.handle(request, response, token))
    const port = await new Promise<number>((resolve, reject) => {
      const attempt = (port: number, retry: boolean) => {
        server.once('error', (error: NodeJS.ErrnoException) => {
          if (retry && error.code === 'EADDRINUSE') attempt(0, false)
          else reject(error)
        })
        server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
      }
      attempt(wanted, wanted !== 0)
    })
    this.server = server
    writeJson(settingsFile, { port, token })
    chmodSync(settingsFile, 0o600)
    const base = `http://127.0.0.1:${port}`
    const scriptUrl = `${base}/page-notes.js?token=${token}`
    this.info = {
      port,
      token,
      scriptUrl,
      snippet: `<script src="${scriptUrl}"></script>`
    }
    return this.info
  }

  list(): BridgeWindow[] {
    this.sweep()
    return [...this.windows.values()].map(({ id, url, title, lastSeen }) => ({ id, url, title, lastSeen }))
  }

  /** Sends one helper operation to a window and waits for its JSON reply. */
  call(windowId: string, operation: PageOperation): Promise<unknown> {
    this.sweep()
    const live = this.windows.get(windowId)
    if (!live) return Promise.reject(new Error('That app window is no longer connected.'))
    return new Promise((resolve, reject) => {
      const id = String(this.nextCall++)
      const pending: Pending = {
        id, operation, resolve, reject,
        timer: setTimeout(() => {
          live.sent.delete(id)
          live.queue = live.queue.filter((entry) => entry !== pending)
          reject(new Error('The app window did not answer.'))
        }, CALL_MS)
      }
      live.queue.push(pending)
      this.flush(live)
    })
  }

  private flush(live: Live): void {
    if (!live.waiter || !live.queue.length) return
    const pending = live.queue.shift()!
    live.sent.set(pending.id, pending)
    const waiter = live.waiter
    live.waiter = null
    if (live.waiterTimer) clearTimeout(live.waiterTimer)
    live.waiterTimer = null
    this.json(waiter, 200, { id: pending.id, operation: pending.operation })
  }

  private sweep(): void {
    const now = Date.now()
    for (const live of this.windows.values()) {
      if (now - live.lastSeen <= GONE_MS || live.waiter) continue
      this.windows.delete(live.id)
      for (const pending of [...live.queue, ...live.sent.values()]) {
        clearTimeout(pending.timer)
        pending.reject(new Error('That app window is no longer connected.'))
      }
    }
  }

  private json(response: ServerResponse, status: number, body?: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' })
    response.end(body === undefined ? undefined : JSON.stringify(body))
  }

  private async body(request: IncomingMessage): Promise<Record<string, unknown> | null> {
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY) return null
      chunks.push(chunk as Buffer)
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return value && typeof value === 'object' ? value as Record<string, unknown> : null
    } catch {
      return null
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    try {
      const port = (this.server?.address() as AddressInfo | null)?.port
      // Refuse other host names, so a web page cannot reach the bridge by DNS rebinding.
      if (request.headers.host !== `127.0.0.1:${port}` && request.headers.host !== `localhost:${port}`) return this.json(response, 421)
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
      if (request.method === 'OPTIONS') return this.json(response, 204)
      if (request.method === 'GET' && url.pathname === '/page-notes.js') {
        if (url.searchParams.get('token') !== token) return this.json(response, 403)
        response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' })
        response.end(bridgeScript(`http://127.0.0.1:${port}`, token))
        return
      }
      if (request.method === 'GET' && url.pathname === '/poll') {
        if (url.searchParams.get('token') !== token) return this.json(response, 403)
        const live = this.windows.get(url.searchParams.get('window') ?? '')
        if (!live) return this.json(response, 410)
        live.lastSeen = Date.now()
        live.url = bounded(url.searchParams.get('url'), 2000) || live.url
        live.title = bounded(url.searchParams.get('title'), 200)
        if (live.waiter) this.json(live.waiter, 204)
        live.waiter = response
        live.waiterTimer = setTimeout(() => {
          if (live.waiter !== response) return
          live.waiter = null
          this.json(response, 204)
        }, POLL_MS)
        response.on('close', () => { if (live.waiter === response) live.waiter = null })
        this.flush(live)
        return
      }
      if (request.method === 'POST' && (url.pathname === '/register' || url.pathname === '/reply')) {
        const body = await this.body(request)
        if (!body || body.token !== token) return this.json(response, 403)
        if (url.pathname === '/register') {
          this.sweep()
          if (this.windows.size >= MAX_WINDOWS) return this.json(response, 429)
          const id = `a${this.nextWindow++}`
          this.windows.set(id, { id, url: bounded(body.url, 2000), title: bounded(body.title, 200), lastSeen: Date.now(), queue: [], sent: new Map(), waiter: null, waiterTimer: null })
          return this.json(response, 200, { windowId: id })
        }
        const live = this.windows.get(typeof body.window === 'string' ? body.window : '')
        const pending = live?.sent.get(typeof body.id === 'string' ? body.id : '')
        if (!live || !pending) return this.json(response, 410)
        live.sent.delete(pending.id)
        clearTimeout(pending.timer)
        pending.resolve(body.reply)
        return this.json(response, 200, {})
      }
      this.json(response, 404)
    } catch {
      if (!response.headersSent) this.json(response, 500)
    }
  }

  async close(): Promise<void> {
    for (const live of this.windows.values()) {
      if (live.waiter) this.json(live.waiter, 204)
      if (live.waiterTimer) clearTimeout(live.waiterTimer)
      for (const pending of [...live.queue, ...live.sent.values()]) {
        clearTimeout(pending.timer)
        pending.reject(new Error('The page bridge closed.'))
      }
    }
    this.windows.clear()
    const server = this.server
    this.server = null
    this.info = null
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
    }
  }
}
