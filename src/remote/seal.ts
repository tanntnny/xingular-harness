// Sealed frames for remote control. A LAN page is served over plain HTTP, where the browser has no
// WebCrypto and anyone on the Wi-Fi can read traffic, so every body is a NaCl secretbox
// (XSalsa20-Poly1305) under a key the phone got from the QR code's fragment, which a browser never
// sends. A random 24-byte nonce per frame; the counter inside the frame stops replays.
import { timingSafeEqual } from 'node:crypto'

import nacl from 'tweetnacl'

import { HarnessError } from '../core/errors'

export const KEY_BYTES = nacl.secretbox.keyLength
/** How far behind the highest counter a frame may arrive, for requests a phone sent at once. */
export const REPLAY_WINDOW = 256

export interface Opened<T> {
  n: number
  body: T
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function newKey(): Uint8Array {
  return nacl.randomBytes(KEY_BYTES)
}

/** URL-safe base64 without padding: it travels in fragments, query strings and SSE lines. */
export function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function decode(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64url'))
}

export function seal(key: Uint8Array, n: number, body: unknown): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
  const box = nacl.secretbox(encoder.encode(JSON.stringify({ n, body })), nonce, key)
  const frame = new Uint8Array(nonce.length + box.length)
  frame.set(nonce)
  frame.set(box, nonce.length)
  return encode(frame)
}

const rejected = () => new HarnessError('unauthorized', 'This remote-control frame could not be opened.')

/**
 * Opens a frame and asks `fresh` whether its counter is new. A frame that fails here is a wrong
 * key, a tampered body, or a replay; callers answer all three the same way.
 */
export function open<T = unknown>(key: Uint8Array, frame: string, fresh: (n: number) => boolean): Opened<T> {
  if (typeof frame !== 'string' || frame.length > 1_500_000) throw rejected()
  const bytes = decode(frame)
  const nonceLength = nacl.secretbox.nonceLength
  if (bytes.length <= nonceLength + nacl.secretbox.overheadLength) throw rejected()
  const plain = nacl.secretbox.open(bytes.subarray(nonceLength), bytes.subarray(0, nonceLength), key)
  if (!plain) throw rejected()
  let value: { n?: unknown; body?: unknown }
  try {
    value = JSON.parse(decoder.decode(plain)) as { n?: unknown; body?: unknown }
  } catch {
    throw rejected()
  }
  if (typeof value.n !== 'number' || !Number.isSafeInteger(value.n) || value.n < 1 || !fresh(value.n)) throw rejected()
  return { n: value.n, body: value.body as T }
}

/**
 * Remembers the counters a sender used: a counter is fresh when it is above the highest seen, or
 * within the window below it and not seen before.
 */
export class ReplayGuard {
  private highest = 0
  private readonly recent = new Set<number>()

  accept(n: number): boolean {
    if (n > this.highest) {
      this.highest = n
      this.recent.add(n)
      for (const seen of this.recent) if (seen <= n - REPLAY_WINDOW) this.recent.delete(seen)
      return true
    }
    if (n <= this.highest - REPLAY_WINDOW || this.recent.has(n)) return false
    this.recent.add(n)
    return true
  }
}

/** Compares two identifiers without leaking how much of them matched. */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
