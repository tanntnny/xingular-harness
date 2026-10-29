// Pairing for remote control. The QR code carries a pairing link: an id and a key, in the URL's
// fragment. A phone that opens it says hello, sealed with that key; the person at the terminal
// confirms; the phone receives its own device key. A link pairs one device and is then replaced,
// so the QR on screen always pairs the next one. Every key lives in memory only (INV-RC-2).
import { randomBytes } from 'node:crypto'

import { HarnessError } from '../core/errors'
import { encode, newKey, open, ReplayGuard, sameSecret, seal } from './seal'

export const MAX_DEVICES = 3
const HELLO_WINDOW_MS = 60_000
const MAX_HELLOS = 10
const MAX_FAILURES = 20
/** Under a minute: a phone's browser gives up on a request it waits on much longer. */
export const CONFIRM_MS = 50_000

export interface RemoteDevice {
  id: string
  label: string
  key: Uint8Array
  pairedAt: number
  lastSeen: number
  /** The counters this device has sent. */
  replay: ReplayGuard
  /** The counter of the last frame sent to it. */
  lastOut: number
}

export interface PairRequest {
  id: string
  label: string
  at: number
}

interface PendingPair extends PairRequest {
  decide(allow: boolean): void
}

interface Link {
  id: string
  key: Uint8Array
}

/** A short, printable name for a browser from its user agent. Nothing from the phone is trusted. */
export function deviceLabel(userAgent: unknown): string {
  const ua = typeof userAgent === 'string' ? userAgent.slice(0, 400) : ''
  const device = /iPad/.test(ua) ? 'iPad'
    : /iPhone/.test(ua) ? 'iPhone'
      : /Android/.test(ua) ? 'Android'
        : /Macintosh|Mac OS X/.test(ua) ? (/Mobile/.test(ua) ? 'iPad' : 'Mac')
          : /Windows/.test(ua) ? 'Windows'
            : /Linux/.test(ua) ? 'Linux' : 'Browser'
  const browser = /EdgiOS|EdgA|Edg\//.test(ua) ? 'Edge'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome'
      : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
        : /Safari\//.test(ua) ? 'Safari' : ''
  return browser ? `${device} · ${browser}` : device
}

const id = (): string => randomBytes(12).toString('base64url')

export class Pairing {
  private link: Link = { id: id(), key: newKey() }
  private linkReplay = new ReplayGuard()
  private pending: PendingPair | null = null
  private readonly devices = new Map<string, RemoteDevice>()
  private hellos: number[] = []
  private failures = 0
  private notice: string | null = null

  constructor(private readonly changed: () => void = () => {}, private readonly clock: () => number = Date.now) {}

  private newLink(): void {
    this.link = { id: id(), key: newKey() }
    this.linkReplay = new ReplayGuard()
  }

  /** What follows `#` in the pairing URL. */
  get fragment(): string {
    return `${this.link.id}.${encode(this.link.key)}`
  }

  get request(): PairRequest | null {
    return this.pending ? { id: this.pending.id, label: this.pending.label, at: this.pending.at } : null
  }

  /** A warning for the terminal page, such as a link replaced after repeated bad attempts. */
  get warning(): string | null {
    return this.notice
  }

  list(): RemoteDevice[] {
    return [...this.devices.values()]
  }

  device(deviceId: string): RemoteDevice | null {
    for (const [known, device] of this.devices) if (sameSecret(known, deviceId)) return device
    return null
  }

  /** A new link; every paired device is dropped and a waiting request denied. */
  rotate(): void {
    this.newLink()
    this.pending?.decide(false)
    this.pending = null
    this.devices.clear()
    this.failures = 0
    this.notice = null
    this.changed()
  }

  forget(deviceId: string): void {
    const device = this.device(deviceId)
    if (device && this.devices.delete(device.id)) this.changed()
  }

  /** The person at the terminal allowed or refused a waiting request. */
  confirm(requestId: string, allow: boolean): void {
    if (!this.pending || this.pending.id !== requestId) throw new HarnessError('invalid_request', 'This pairing request is no longer waiting.')
    this.pending.decide(allow)
  }

  private fail(): HarnessError {
    this.failures += 1
    if (this.failures >= MAX_FAILURES) {
      this.newLink()
      this.failures = 0
      this.notice = 'Too many failed pairing attempts. The link was replaced; scan the new QR code.'
      this.changed()
    }
    return new HarnessError('unauthorized', 'This pairing link is not valid. Scan the QR code in the terminal again.')
  }

  /**
   * A phone opened the pairing link. Waits until the person at the terminal decides, then returns
   * the device's id and key, sealed with the link key.
   */
  async hello(pairingId: unknown, frame: unknown, confirmMs = CONFIRM_MS): Promise<string> {
    const at = this.clock()
    this.hellos = this.hellos.filter((time) => at - time < HELLO_WINDOW_MS)
    if (this.hellos.length >= MAX_HELLOS) throw new HarnessError('rate_limited', 'Too many pairing attempts. Wait a minute and try again.')
    this.hellos.push(at)
    if (typeof pairingId !== 'string' || typeof frame !== 'string' || !sameSecret(pairingId, this.link.id)) throw this.fail()
    const link = this.link
    let body: { userAgent?: unknown }
    try {
      body = open<{ userAgent?: unknown }>(link.key, frame, (n) => this.linkReplay.accept(n)).body ?? {}
    } catch {
      throw this.fail()
    }
    if (this.pending) throw new HarnessError('remote_busy', 'Another device is waiting for approval in the terminal.')
    if (this.devices.size >= MAX_DEVICES) throw new HarnessError('remote_full', `At most ${MAX_DEVICES} devices can control a session. Press n in /remote-control to start over.`)
    const label = deviceLabel(body.userAgent)
    const allowed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => decide(false), confirmMs)
      timer.unref?.()
      const decide = (allow: boolean) => {
        clearTimeout(timer)
        if (this.pending?.decide === decide) this.pending = null
        resolve(allow)
        this.changed()
      }
      this.pending = { id: id(), label, at, decide }
      this.changed()
    })
    // A rotation while the phone waited replaced this link; its request is void.
    if (!allowed || this.link !== link) throw new HarnessError('remote_denied', 'Pairing was not allowed at the terminal.')
    const device: RemoteDevice = { id: id(), label, key: newKey(), pairedAt: this.clock(), lastSeen: this.clock(), replay: new ReplayGuard(), lastOut: 0 }
    this.devices.set(device.id, device)
    // The link paired its device; the QR on screen now pairs the next one.
    this.newLink()
    this.changed()
    return seal(link.key, 1, { deviceId: device.id, deviceKey: encode(device.key), label })
  }

  /** Opens a paired device's frame, enforcing its counter. */
  openFrom<T = unknown>(deviceId: unknown, frame: unknown): { device: RemoteDevice; body: T } {
    const device = typeof deviceId === 'string' ? this.device(deviceId) : null
    if (!device || typeof frame !== 'string') throw new HarnessError('unauthorized', 'This device is not paired with the session. Scan the QR code in the terminal again.')
    const opened = open<T>(device.key, frame, (n) => device.replay.accept(n))
    device.lastSeen = this.clock()
    return { device, body: opened.body }
  }

  sealFor(device: RemoteDevice, body: unknown): string {
    device.lastOut += 1
    return seal(device.key, device.lastOut, body)
  }
}
