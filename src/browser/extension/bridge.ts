import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { readJsonOr, writeJson } from '../../core/fs'

const DEFAULT_PORT = 38671
const GONE_MS = 45_000
const POLL_MS = 20_000
const REQUEST_MS = 60_000
const PAIR_MS = 5 * 60_000
const MAX_BODY = 8_000_000
const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/

export interface BrowserExtensionStatus {
  state: 'stopped' | 'pairing' | 'waiting' | 'connected' | 'paused'
  paired: boolean
  connected: boolean
  paused: boolean
  port: number | null
  lastSeenAt: number | null
}

export interface BrowserExtensionStart {
  status: BrowserExtensionStatus
  pairingCode?: string
  expiresAt?: number
}

interface Pending {
  id: string
  operation: unknown
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface SavedBridge {
  port?: number
  accessToken?: string
  origin?: string
  paused?: boolean
}

const bounded = (value: unknown, max: number): string => typeof value === 'string' ? Array.from(value).slice(0, max).join('') : ''

function sameSecret(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

export class BrowserExtensionBridge {
  private server: Server | null = null
  private starting: Promise<BrowserExtensionStart> | null = null
  private port: number | null = null
  private accessToken: string | null = null
  private origin: string | null = null
  private pairing: { code: string; expiresAt: number } | null = null
  private lastSeenAt: number | null = null
  private paused = false
  private waiter: ServerResponse | null = null
  private waiterTimer: NodeJS.Timeout | null = null
  private readonly queue: Pending[] = []
  private readonly sent = new Map<string, Pending>()
  private attempts: number[] = []
  private nextAttemptAt = 0

  constructor(private readonly options: { stateDir: string; port?: number }) {
    const settingsFile = this.settingsFile()
    if (existsSync(settingsFile)) chmodSync(settingsFile, 0o600)
    const saved = readJsonOr<SavedBridge>(settingsFile, {})
    if (typeof saved.accessToken === 'string' && /^[a-f0-9]{48}$/.test(saved.accessToken) && typeof saved.origin === 'string' && EXTENSION_ORIGIN.test(saved.origin)) {
      this.accessToken = saved.accessToken
      this.origin = saved.origin
    }
    this.paused = saved.paused === true
    if (Number.isInteger(saved.port) && saved.port! > 0 && saved.port! < 65536) this.port = saved.port!
  }

  private settingsFile(): string {
    return join(this.options.stateDir, 'browser', 'extension-bridge.json')
  }

  private save(): void {
    const path = this.settingsFile()
    mkdirSync(join(this.options.stateDir, 'browser'), { recursive: true })
    if (!this.accessToken || !this.origin || !this.port) {
      rmSync(path, { force: true })
      return
    }
    writeJson(path, { port: this.port, accessToken: this.accessToken, origin: this.origin, paused: this.paused })
    chmodSync(path, 0o600)
  }

  status(): BrowserExtensionStatus {
    const connected = Boolean(this.lastSeenAt && Date.now() - this.lastSeenAt <= GONE_MS)
    const paired = Boolean(this.accessToken && this.origin)
    const state: BrowserExtensionStatus['state'] = !this.server
      ? 'stopped'
      : this.paused && connected
        ? 'paused'
        : connected
          ? 'connected'
          : paired
            ? 'waiting'
            : 'pairing'
    return { state, paired, connected, paused: this.paused, port: this.server ? this.port : null, lastSeenAt: connected ? this.lastSeenAt : null }
  }

  /** Starts the loopback bridge and returns a short-lived code for the extension's explicit pair action. */
  start(): Promise<BrowserExtensionStart> {
    if (this.server) return Promise.resolve(this.startResult())
    this.starting ??= this.listen().finally(() => { this.starting = null })
    return this.starting
  }

  private startResult(): BrowserExtensionStart {
    if (this.accessToken && this.origin) return { status: this.status() }
    if (!this.pairing || this.pairing.expiresAt <= Date.now()) {
      this.pairing = { code: randomBytes(6).toString('hex').toUpperCase(), expiresAt: Date.now() + PAIR_MS }
    }
    return {
      status: this.status(),
      pairingCode: `${this.port}:${this.pairing.code}`,
      expiresAt: this.pairing.expiresAt
    }
  }

  private async listen(): Promise<BrowserExtensionStart> {
    const savedPort = this.options.port ?? this.port ?? DEFAULT_PORT
    const server = createServer((request, response) => void this.handle(request, response))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(savedPort, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    this.server = server
    this.port = (server.address() as AddressInfo).port
    this.save()
    return this.startResult()
  }

  /** One request from the browser at a time; the extension's poll loop serializes the live tabs. */
  request(operation: unknown): Promise<unknown> {
    if (!this.server || !this.accessToken || !this.origin || !this.status().connected) {
      return Promise.reject(new Error('Brave is not connected. Connect the extension in Browser settings; nothing was done.'))
    }
    if (this.paused) return Promise.reject(new Error('Brave control is paused by the user. Resume it from the page badge; nothing was done.'))
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        id: randomUUID(), operation, resolve, reject,
        timer: setTimeout(() => {
          this.sent.delete(pending.id)
          const queued = this.queue.indexOf(pending)
          if (queued >= 0) this.queue.splice(queued, 1)
          reject(new Error('Brave did not answer before the browser call timed out. Its outcome is unknown; take a fresh snapshot before trying again.'))
        }, REQUEST_MS)
      }
      pending.timer.unref?.()
      this.queue.push(pending)
      this.flush()
    })
  }

  async stop(): Promise<BrowserExtensionStatus> {
    this.revoke()
    await this.closeServer()
    return this.status()
  }

  /** Keeps pairing across a normal Harness shutdown so the extension can reconnect to this profile. */
  async close(): Promise<void> {
    this.lastSeenAt = null
    this.rejectPending(new Error('The Harness stopped the Brave bridge.'), 503)
    await this.closeServer()
  }

  private revoke(): void {
    const origin = this.origin
    this.pairing = null
    this.accessToken = null
    this.origin = null
    this.lastSeenAt = null
    this.paused = false
    this.save()
    this.rejectPending(new Error('Brave control was stopped by the user.'), 410, origin)
  }

  private rejectPending(error: Error, status: 410 | 503 = 410, origin = this.origin): void {
    if (this.waiter) this.json(this.waiter, status, { error: status === 410 ? 'bridge_stopped' : 'bridge_unavailable' }, origin ?? undefined)
    this.waiter = null
    if (this.waiterTimer) clearTimeout(this.waiterTimer)
    this.waiterTimer = null
    for (const pending of [...this.queue, ...this.sent.values()]) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.queue.length = 0
    this.sent.clear()
  }

  private async closeServer(): Promise<void> {
    const server = this.server
    this.server = null
    this.port = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private flush(): void {
    if (!this.waiter || !this.queue.length) return
    const pending = this.queue.shift()!
    this.sent.set(pending.id, pending)
    const waiter = this.waiter
    this.waiter = null
    if (this.waiterTimer) clearTimeout(this.waiterTimer)
    this.waiterTimer = null
    this.json(waiter, 200, { id: pending.id, operation: pending.operation })
  }

  private json(response: ServerResponse, status: number, body?: unknown, origin?: string | null): void {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': origin ?? 'null',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type',
      'access-control-max-age': '60',
      vary: 'Origin'
    })
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
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
    } catch {
      return null
    }
  }

  private originAllowed(origin: string | null, pairing = false): origin is string {
    if (!origin || !EXTENSION_ORIGIN.test(origin)) return false
    return pairing || origin === this.origin
  }

  // Extension service-worker fetches may omit Origin; the bearer token remains mandatory.
  private authorized(request: IncomingMessage, origin: string | null): boolean {
    if (!this.accessToken || (origin !== null && !this.originAllowed(origin))) return false
    const authorization = request.headers.authorization ?? ''
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    return sameSecret(token, this.accessToken)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const port = this.port
      if (!port || request.headers.host !== `127.0.0.1:${port}`) return this.json(response, 421)
      const origin = typeof request.headers.origin === 'string' ? request.headers.origin : null
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
      if (request.method === 'OPTIONS') {
        const pairing = url.pathname === '/pair'
        if (!this.originAllowed(origin, pairing)) return this.json(response, 403)
        return this.json(response, 204, undefined, origin)
      }
      if (request.method === 'POST' && url.pathname === '/pair') {
        if (!this.originAllowed(origin, true)) return this.json(response, 403)
        if (Date.now() < this.nextAttemptAt) return this.json(response, 429, { error: 'rate_limited' }, origin)
        const body = await this.body(request)
        const supplied = bounded(body?.code, 40)
        const expected = this.pairing?.code ?? ''
        const valid = Boolean(expected && this.pairing && this.pairing.expiresAt > Date.now() && sameSecret(supplied, expected))
        if (!valid) {
          this.attempts.push(Date.now())
          this.attempts = this.attempts.filter((at) => Date.now() - at < 60_000)
          if (this.attempts.length >= 5) this.nextAttemptAt = Date.now() + 60_000
          return this.json(response, this.attempts.length >= 5 ? 429 : 403, { error: 'invalid_pairing_code' }, origin)
        }
        this.pairing = null
        this.attempts = []
        this.nextAttemptAt = 0
        this.accessToken = randomBytes(24).toString('hex')
        this.origin = origin
        this.lastSeenAt = null
        this.paused = false
        this.save()
        return this.json(response, 200, { token: this.accessToken }, origin)
      }
      if (!this.authorized(request, origin)) return this.json(response, 403)
      if (request.method === 'GET' && url.pathname === '/status') return this.json(response, 200, this.status(), origin)
      if (request.method === 'GET' && url.pathname === '/poll') {
        this.lastSeenAt = Date.now()
        if (this.waiter) this.json(this.waiter, 409, { error: 'poll_replaced' }, origin)
        this.waiter = response
        if (this.waiterTimer) clearTimeout(this.waiterTimer)
        this.waiterTimer = setTimeout(() => {
          if (this.waiter !== response) return
          this.waiter = null
          this.json(response, 204, undefined, origin)
        }, POLL_MS)
        this.waiterTimer.unref?.()
        this.flush()
        return
      }
      if (request.method === 'POST' && url.pathname === '/reply') {
        const body = await this.body(request)
        const id = bounded(body?.id, 80)
        const pending = this.sent.get(id)
        if (!pending) return this.json(response, 404, { error: 'unknown_request' }, origin)
        this.sent.delete(id)
        clearTimeout(pending.timer)
        pending.resolve(body?.result)
        return this.json(response, 200, { ok: true }, origin)
      }
      if (request.method === 'POST' && url.pathname === '/control') {
        const body = await this.body(request)
        const action = body?.action
        if (action === 'pause') {
          this.paused = true
          this.save()
          for (const pending of this.queue.splice(0)) {
            clearTimeout(pending.timer)
            pending.reject(new Error('Brave control was paused by the user; nothing was done.'))
          }
        } else if (action === 'resume') {
          this.paused = false
          this.save()
        } else if (action === 'stop') {
          this.revoke()
          const status = this.status()
          this.json(response, 200, { status }, origin)
          setImmediate(() => void this.closeServer())
          return
        } else return this.json(response, 400, { error: 'invalid_action' }, origin)
        return this.json(response, 200, { status: this.status() }, origin)
      }
      this.json(response, 404, { error: 'not_found' }, origin)
    } catch {
      if (!response.headersSent) this.json(response, 500, { error: 'bridge_error' })
      else response.end()
    }
  }
}
