import { describe, expect, it } from 'vitest'

import { REPLAY_WINDOW, ReplayGuard, decode, encode, newKey, open, sameSecret, seal } from './seal'

describe('sealed remote-control frames', () => {
  it('round-trips a body and refuses a wrong key or a changed byte', () => {
    const key = newKey()
    const frame = seal(key, 7, { method: 'send', params: { text: 'hello' } })
    expect(open(key, frame, () => true)).toEqual({ n: 7, body: { method: 'send', params: { text: 'hello' } } })
    expect(() => open(newKey(), frame, () => true)).toThrow('could not be opened')
    const bytes = decode(frame)
    bytes[bytes.length - 1] ^= 1
    expect(() => open(key, encode(bytes), () => true)).toThrow('could not be opened')
    expect(() => open(key, 'not a frame', () => true)).toThrow('could not be opened')
  })

  it('refuses a frame whose counter the guard has seen', () => {
    const key = newKey()
    const guard = new ReplayGuard()
    const accept = (n: number) => guard.accept(n)
    const first = seal(key, 10, {})
    expect(open(key, first, accept).n).toBe(10)
    expect(() => open(key, first, accept)).toThrow()
    // Requests sent together may arrive out of order.
    expect(open(key, seal(key, 12, {}), accept).n).toBe(12)
    expect(open(key, seal(key, 11, {}), accept).n).toBe(11)
    expect(() => open(key, seal(key, 11, {}), accept)).toThrow()
  })

  it('forgets counters far behind the highest one', () => {
    const guard = new ReplayGuard()
    expect(guard.accept(1000)).toBe(true)
    expect(guard.accept(1000 - REPLAY_WINDOW)).toBe(false)
    expect(guard.accept(1000 - REPLAY_WINDOW + 1)).toBe(true)
  })

  it('compares secrets of different lengths without throwing', () => {
    expect(sameSecret('abc', 'abc')).toBe(true)
    expect(sameSecret('abc', 'abd')).toBe(false)
    expect(sameSecret('abc', 'abcd')).toBe(false)
  })
})
