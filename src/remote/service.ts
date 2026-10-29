// Remote control of one terminal session (15-remote-control.md). A paired phone becomes a second
// person at the terminal: it sends prompts, watches, interrupts, and answers decisions, all through
// the same controller and Terminals methods the terminal uses (INV-RC-3). It reaches nothing else:
// no commands, no shell, no links, no plugins or accounts (INV-RC-6).
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

import { DEFAULT_PRODUCT_NAME } from '../core/env'
import { HarnessError } from '../core/errors'
import type { RunEvent } from '../sessions/contracts'
import { hostPart, pickRemoteAddress, remoteAddresses, type RemoteAddress, type RemoteAddressKind, type RemoteInterfaceChoice } from './addresses'
import { Pairing, type PairRequest, type RemoteDevice } from './pairing'
import { listenRemote, type RemoteAsset, type RemoteListening, type RemoteStream } from './server'
import { PAGE_CSS, PAGE_JS, pageHtml, pageManifest } from './webClient'

const MAX_TEXT = 1_000_000
const MAX_HISTORY = 400

/** The session remote control drives. Terminals supplies it; tests supply a fake. */
export interface RemoteSessionPort {
  sessionId: string
  /** A short title for the phone's header. */
  title(): string
  send(text: string): Promise<{ runId: string }>
  /** One of the terminal controller's decision calls. */
  control(call: 'terminal.interrupt' | 'terminal.approve' | 'terminal.answer' | 'terminal.answers' | 'terminal.pending.wait', params: Record<string, unknown>): Promise<unknown>
  /** The conversation so far, as saved run events, oldest first. */
  history(): RunEvent[]
  /** Events of this session's own runs, after they are redacted and saved. */
  listen(listener: (event: RunEvent) => void): () => void
  state(): { ready: boolean; active: boolean }
}

/** What the phone is sent for one run event. Everything else in an event stays on the computer. */
export type PhoneEvent =
  | { kind: 'delta'; runId: string; messageId: string; text: string }
  | { kind: 'message'; runId: string; messageId: string; role: 'user' | 'assistant'; text: string }
  | { kind: 'tool'; runId: string; id: string; name: string; phase: 'start' | 'end'; summary?: string; ok?: boolean }
  | { kind: 'run'; runId: string; status: string }
  | { kind: 'todo'; runId: string; items: Array<{ text: string; status: string }> }

const text = (value: unknown, size = MAX_TEXT): string => (typeof value === 'string' ? value.slice(0, size) : '')

export function projectEvent(event: RunEvent): PhoneEvent | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const runId = event.runId
  switch (event.type) {
    case 'message.delta':
      return { kind: 'delta', runId, messageId: text(payload.messageId, 200), text: text(payload.text) }
    case 'message.completed':
      return { kind: 'message', runId, messageId: text(payload.messageId, 200), role: payload.role === 'user' ? 'user' : 'assistant', text: text(payload.text) }
    case 'message.steered':
      return { kind: 'message', runId, messageId: event.id, role: 'user', text: text(payload.text) }
    case 'tool.started':
      return { kind: 'tool', runId, id: text(payload.toolCallId, 200), name: text(payload.name, 200), phase: 'start', summary: text(payload.summary, 400) }
    case 'tool.completed':
      return { kind: 'tool', runId, id: text(payload.toolCallId, 200), name: text(payload.name, 200), phase: 'end', ok: payload.ok !== false }
    case 'started':
      return { kind: 'run', runId, status: 'running' }
    case 'completed':
    case 'failed':
      return { kind: 'run', runId, status: event.type }
    case 'status.changed':
      return { kind: 'run', runId, status: text(payload.status, 40) || 'running' }
    case 'todo.updated': {
      const items = Array.isArray(payload.items) ? payload.items.slice(0, 50) : []
      return { kind: 'todo', runId, items: items.map((item) => ({ text: text((item as Record<string, unknown>)?.text, 500), status: text((item as Record<string, unknown>)?.status, 20) })) }
    }
    default:
      return null
  }
}

/** A pending decision as the phone shows it. The approval's full action text is kept whole. */
export function projectRequest(request: Record<string, unknown>): Record<string, unknown> {
  const options = Array.isArray(request.options) ? request.options.slice(0, 12).map((option) => {
    const value = option as Record<string, unknown>
    return { label: text(value?.label, 200), description: text(value?.description, 600), recommended: value?.recommended === true }
  }) : []
  return {
    requestId: text(request.requestId, 200),
    type: request.type === 'question' ? 'question' : 'approval',
    runId: text(request.runId, 200),
    target: text(request.target, 400),
    action: text(request.action, 64_000),
    rememberable: request.rememberable === true,
    summary: text(request.summary, 2_000),
    question: text(request.question, 4_000),
    options,
    multiSelect: request.multiSelect === true,
    batchId: text(request.batchId, 200),
    batchIndex: typeof request.batchIndex === 'number' ? request.batchIndex : 0
  }
}

/** What the phone may type. Commands and shell escapes belong to the terminal (INV-RC-6). */
export function checkPrompt(value: unknown): string {
  const prompt = typeof value === 'string' ? value : ''
  if (!prompt.trim()) throw new HarnessError('invalid_request', 'Message is empty.')
  if (prompt.length > MAX_TEXT) throw new HarnessError('too_large', 'This message is too large.')
  const first = prompt.trimStart()[0]
  if (first === '/' || first === '!') throw new HarnessError('invalid_request', 'Slash commands and ! shell commands run only at the terminal.')
  return prompt
}

export interface RemoteStatus {
  running: boolean
  revision: number
  url: string | null
  kind: RemoteAddressKind | null
  /** Which address kinds this computer has, for switching. */
  kinds: RemoteAddressKind[]
  devices: Array<{ id: string; label: string; connected: boolean }>
  request: PairRequest | null
  warning: string | null
}

export interface RemoteControlOptions {
  /** Addresses to choose from; the computer's own by default. */
  addresses?: () => RemoteAddress[]
  /** Listen here instead of the chosen address, for tests. */
  bindHost?: string
  port?: number
  /** The host's product name for the phone page (`env.productName`). */
  productName?: string
}

let naclSource: string | null = null
function naclScript(): string {
  naclSource ??= readFileSync(createRequire(import.meta.url).resolve('tweetnacl/nacl-fast.min.js'), 'utf8')
  return naclSource
}

interface Connection {
  device: RemoteDevice
  stream: RemoteStream
}

export class RemoteControl {
  private listening: RemoteListening | null = null
  private address: RemoteAddress | null = null
  private pairing: Pairing
  private readonly connections = new Set<Connection>()
  private revision = 0
  private readonly waiters = new Set<() => void>()
  private unlisten: (() => void) | null = null
  private pendingLoop: AbortController | null = null
  private pendingRequests: Record<string, unknown>[] = []
  private starting: Promise<RemoteStatus> | null = null
  private ended = false

  constructor(private readonly session: RemoteSessionPort, private readonly options: RemoteControlOptions = {}) {
    this.pairing = new Pairing(() => this.changed())
  }

  private changed(): void {
    this.revision += 1
    for (const wake of this.waiters) wake()
  }

  status(): RemoteStatus {
    const kinds = [...new Set((this.options.addresses ?? remoteAddresses)().map((address) => address.kind))]
    const connected = new Set([...this.connections].map((connection) => connection.device.id))
    return {
      running: !!this.listening,
      revision: this.revision,
      url: this.listening && this.address ? `${this.base()}/#${this.pairing.fragment}` : null,
      kind: this.listening ? this.address?.kind ?? null : null,
      kinds,
      devices: this.pairing.list().map((device) => ({ id: device.id, label: device.label, connected: connected.has(device.id) })),
      request: this.pairing.request,
      warning: this.pairing.warning
    }
  }

  /** Returns at once for a changed revision, otherwise after a change or 20 seconds. */
  async waitStatus(revision: unknown): Promise<RemoteStatus> {
    if (revision === this.revision && !this.ended) {
      await new Promise<void>((resolve) => {
        const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve() }
        const timer = setTimeout(wake, 20_000)
        timer.unref?.()
        this.waiters.add(wake)
      })
    }
    return this.status()
  }

  private base(): string {
    const address = this.address!
    return `http://${hostPart(address)}:${this.listening!.port}`
  }

  /** Starts listening, or switches address kind. Starting again with the same kind changes nothing. */
  async start(choice: RemoteInterfaceChoice = 'auto'): Promise<RemoteStatus> {
    if (this.ended) throw new HarnessError('terminal_not_ready', 'This terminal has ended.')
    if (this.starting) await this.starting.catch(() => undefined)
    if (this.listening && (choice === 'auto' || choice === this.address?.kind)) return this.status()
    this.starting = this.listen(choice)
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  private async listen(choice: RemoteInterfaceChoice): Promise<RemoteStatus> {
    const address = pickRemoteAddress(choice, (this.options.addresses ?? remoteAddresses)())
    await this.close(false)
    const host = this.options.bindHost ?? address.address
    this.listening = await listenRemote(host, this.options.port ?? 0, {
      asset: (path) => this.asset(path),
      hello: async (body) => ({ f: await this.pairing.hello(body.p, body.f) }),
      call: (body) => this.call(body),
      stream: (deviceId, frame, stream) => this.openStream(deviceId, frame, stream)
    })
    this.address = this.options.bindHost ? { ...address, address: this.options.bindHost, family: host.includes(':') ? 'IPv6' : 'IPv4' } : address
    this.unlisten = this.session.listen((event) => {
      const projected = projectEvent(event)
      if (projected) this.broadcast({ type: 'event', event: projected })
    })
    this.changed()
    return this.status()
  }

  /** A new pairing link; every paired phone is disconnected. */
  rotate(): RemoteStatus {
    for (const connection of [...this.connections]) this.drop(connection, { type: 'unpaired' })
    this.pairing.rotate()
    return this.status()
  }

  confirm(requestId: string, allow: boolean): RemoteStatus {
    this.pairing.confirm(requestId, allow)
    return this.status()
  }

  /** Stops remote control; phones are told the session is no longer reachable. */
  async stop(): Promise<RemoteStatus> {
    await this.close(true)
    this.changed()
    return this.status()
  }

  /** The terminal session ended (INV-RC-5). */
  async dispose(): Promise<void> {
    if (this.ended) return
    await this.close(true)
    this.ended = true
    this.changed()
  }

  private async close(unpair: boolean): Promise<void> {
    this.unlisten?.()
    this.unlisten = null
    this.pendingLoop?.abort()
    this.pendingLoop = null
    for (const connection of [...this.connections]) this.drop(connection, { type: 'ended' })
    const listening = this.listening
    this.listening = null
    if (unpair) this.pairing = new Pairing(() => this.changed())
    await listening?.close()
  }

  private get productName(): string {
    return this.options.productName ?? DEFAULT_PRODUCT_NAME
  }

  private asset(path: string): RemoteAsset | null {
    if (path === '/') return { type: 'text/html; charset=utf-8', body: pageHtml(this.productName) }
    if (path === '/app.js') return { type: 'text/javascript; charset=utf-8', body: PAGE_JS }
    if (path === '/app.css') return { type: 'text/css; charset=utf-8', body: PAGE_CSS }
    if (path === '/nacl.js') return { type: 'text/javascript; charset=utf-8', body: naclScript() }
    if (path === '/manifest.webmanifest') return { type: 'application/manifest+json', body: pageManifest(this.productName) }
    return null
  }

  private send(connection: Connection, body: unknown): void {
    connection.stream.send(this.pairing.sealFor(connection.device, body))
  }

  private broadcast(body: unknown): void {
    for (const connection of this.connections) this.send(connection, body)
  }

  private drop(connection: Connection, last: unknown): void {
    try { this.send(connection, last) } catch {}
    this.connections.delete(connection)
    connection.stream.end()
  }

  private openStream(deviceId: string, frame: string, stream: RemoteStream): () => void {
    const { device } = this.pairing.openFrom(deviceId, frame)
    const connection: Connection = { device, stream }
    this.connections.add(connection)
    this.send(connection, { type: 'pending', requests: this.pendingRequests.map(projectRequest) })
    this.watchPending()
    this.changed()
    return () => {
      if (this.connections.delete(connection)) this.changed()
      if (!this.connections.size) {
        this.pendingLoop?.abort()
        this.pendingLoop = null
      }
    }
  }

  /** Follows the controller's decisions while a phone is connected, as the terminal itself does. */
  private watchPending(): void {
    if (this.pendingLoop) return
    const loop = new AbortController()
    this.pendingLoop = loop
    void (async () => {
      let revision: number | undefined
      while (!loop.signal.aborted) {
        try {
          const snapshot = await this.session.control('terminal.pending.wait', { revision }) as { revision: number; requests: Record<string, unknown>[] }
          if (loop.signal.aborted) return
          const changed = snapshot.revision !== revision
          revision = snapshot.revision
          this.pendingRequests = snapshot.requests
          if (changed) this.broadcast({ type: 'pending', requests: snapshot.requests.map(projectRequest) })
        } catch {
          if (loop.signal.aborted) return
          await new Promise((resolve) => setTimeout(resolve, 1000).unref?.())
          revision = undefined
        }
      }
    })()
  }

  private async call(body: Record<string, unknown>): Promise<{ f: string }> {
    const { device, body: request } = this.pairing.openFrom<{ id?: unknown; method?: unknown; params?: unknown }>(body.d, body.f)
    const id = request?.id ?? null
    const params = (request?.params && typeof request.params === 'object' ? request.params : {}) as Record<string, unknown>
    try {
      const result = await this.dispatch(device, String(request?.method ?? ''), params)
      return { f: this.pairing.sealFor(device, { id, result }) }
    } catch (error) {
      const shape = error instanceof HarnessError ? { code: error.code, message: error.message } : { code: 'harness_error', message: error instanceof Error ? error.message : String(error) }
      return { f: this.pairing.sealFor(device, { id, error: shape }) }
    }
  }

  private async dispatch(device: RemoteDevice, method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'snapshot': {
        const events = this.session.history().map(projectEvent).filter((event): event is PhoneEvent => !!event && event.kind !== 'delta')
        return {
          title: this.session.title(),
          device: device.label,
          events: events.slice(-MAX_HISTORY),
          pending: this.pendingRequests.map(projectRequest),
          state: this.session.state()
        }
      }
      case 'send':
        return this.session.send(checkPrompt(params.text))
      case 'interrupt':
        return this.session.control('terminal.interrupt', {})
      case 'approve':
        return this.session.control('terminal.approve', { requestId: String(params.requestId ?? ''), decision: params.decision, alwaysAllow: params.alwaysAllow === true })
      case 'answer':
        return this.session.control('terminal.answer', { requestId: String(params.requestId ?? ''), answer: params.answer })
      case 'answers':
        return this.session.control('terminal.answers', { batchId: String(params.batchId ?? ''), answers: params.answers })
      case 'unpair':
        this.pairing.forget(device.id)
        for (const connection of [...this.connections]) if (connection.device === device) this.drop(connection, { type: 'unpaired' })
        return {}
      default:
        throw new HarnessError('unknown_method', 'The phone asked for something remote control does not offer.')
    }
  }
}
