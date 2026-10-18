import { describe, expect, it, vi } from 'vitest'

import { LOG_READ_CHUNK_BYTES, readHarnessLogSnapshot } from './logs'

describe('terminal diagnostic log snapshots', () => {
  it('reads the complete fixed-size snapshot in bounded byte chunks', async () => {
    const original = `${'x'.repeat(LOG_READ_CHUNK_BYTES - 1)}🧠and the rest`
    const bytes = Buffer.from(original)
    const info = vi.fn(async () => ({ size: bytes.length }))
    const chunk = vi.fn(async (snapshotSize: number, offset: number) => {
      expect(snapshotSize).toBe(bytes.length)
      const nextOffset = Math.min(bytes.length, offset + LOG_READ_CHUNK_BYTES)
      return { data: bytes.subarray(offset, nextOffset).toString('base64'), nextOffset }
    })

    await expect(readHarnessLogSnapshot(info, chunk)).resolves.toBe(original)
    expect(chunk).toHaveBeenCalledTimes(2)
    expect(chunk.mock.calls.map(([, offset]) => offset)).toEqual([0, LOG_READ_CHUNK_BYTES])
  })

  it('returns an empty snapshot when this host has not captured process diagnostics', async () => {
    const chunk = vi.fn()
    await expect(readHarnessLogSnapshot(async () => ({ size: null }), chunk)).resolves.toBe('')
    expect(chunk).not.toHaveBeenCalled()
  })
})
