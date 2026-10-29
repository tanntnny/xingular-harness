import { describe, expect, it, vi } from 'vitest'

import { MAX_DEVICES, Pairing, deviceLabel } from './pairing'
import { decode, open, seal } from './seal'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

function link(pairing: Pairing) {
  const [id, key] = pairing.fragment.split('.')
  return { id: id!, key: decode(key!) }
}

async function pair(pairing: Pairing, userAgent = IPHONE) {
  const { id, key } = link(pairing)
  const reply = pairing.hello(id, seal(key, 1, { userAgent }))
  await vi.waitFor(() => expect(pairing.request).not.toBeNull())
  pairing.confirm(pairing.request!.id, true)
  const opened = open<{ deviceId: string; deviceKey: string; label: string }>(key, await reply, () => true)
  return { ...opened.body, key: decode(opened.body.deviceKey) }
}

describe('remote-control pairing', () => {
  it('names browsers from their user agent', () => {
    expect(deviceLabel(IPHONE)).toBe('iPhone · Safari')
    expect(deviceLabel('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) CriOS/130.0 Mobile Safari/604.1')).toBe('iPad · Chrome')
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Mobile/15E148 Safari/605.1.15')).toBe('iPad · Safari')
    expect(deviceLabel(42)).toBe('Browser')
  })

  it('pairs a device only after the person confirms, then replaces the link', async () => {
    const changed = vi.fn()
    const pairing = new Pairing(changed)
    const before = pairing.fragment
    const device = await pair(pairing)
    expect(device.label).toBe('iPhone · Safari')
    expect(pairing.list().map((known) => known.id)).toEqual([device.deviceId])
    expect(pairing.fragment).not.toBe(before)
    expect(changed).toHaveBeenCalled()

    const frame = seal(device.key, 5, { method: 'snapshot' })
    expect(pairing.openFrom(device.deviceId, frame).body).toEqual({ method: 'snapshot' })
    expect(() => pairing.openFrom(device.deviceId, frame)).toThrow('could not be opened')
    expect(() => pairing.openFrom('someone-else', frame)).toThrow('not paired')
  })

  it('refuses a used link, a denied request and a request that times out', async () => {
    const pairing = new Pairing()
    const used = link(pairing)
    await pair(pairing)
    await expect(pairing.hello(used.id, seal(used.key, 2, {}))).rejects.toThrow('not valid')

    const next = link(pairing)
    const denied = pairing.hello(next.id, seal(next.key, 1, { userAgent: IPHONE }))
    await vi.waitFor(() => expect(pairing.request).not.toBeNull())
    pairing.confirm(pairing.request!.id, false)
    await expect(denied).rejects.toThrow('not allowed')

    await expect(pairing.hello(next.id, seal(next.key, 2, {}), 5)).rejects.toThrow('not allowed')
    expect(pairing.request).toBeNull()
  })

  it('drops every device when the link is rotated', async () => {
    const pairing = new Pairing()
    const device = await pair(pairing)
    pairing.rotate()
    expect(pairing.list()).toEqual([])
    expect(() => pairing.openFrom(device.deviceId, seal(device.key, 1, {}))).toThrow('not paired')
  })

  it('limits devices, attempts and failures', async () => {
    let now = 0
    const pairing = new Pairing(() => {}, () => now)
    for (let index = 0; index < MAX_DEVICES; index += 1) {
      await pair(pairing)
      now += 61_000
    }
    const full = link(pairing)
    await expect(pairing.hello(full.id, seal(full.key, 1, {}))).rejects.toThrow(`At most ${MAX_DEVICES}`)

    const fresh = new Pairing(() => {}, () => now)
    for (let index = 0; index < 10; index += 1) await expect(fresh.hello('wrong', 'frame')).rejects.toThrow('not valid')
    await expect(fresh.hello('wrong', 'frame')).rejects.toThrow('Too many pairing attempts')

    const guarded = new Pairing(() => {}, () => now)
    const original = guarded.fragment
    for (let index = 0; index < 20; index += 1) {
      now += 61_000
      await expect(guarded.hello('wrong', 'frame')).rejects.toThrow('not valid')
    }
    expect(guarded.fragment).not.toBe(original)
    expect(guarded.warning).toContain('Too many failed pairing attempts')
  })
})
