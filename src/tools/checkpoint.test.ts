import { describe, expect, it } from 'vitest'

import { ackCheckpoint, checkpointOf, checkpointTool, describeCheckpoint, parseCheckpoint } from './checkpoint'
import { runEventPayloadSchemas, type RunEvent } from '../sessions/contracts'

const full = {
  summary: 'Finished the first half of the boundary work.',
  done: [{ item: 'Hardened the sandbox', evidence: ['src/core/workspaceSandbox.ts', 'npm test'] }],
  next: 'Run the Linux sandbox suite.',
  blocked: 'No Linux runner yet.',
  files: [{ path: 'src/core/workspaceSandbox.ts', why: 'the boundary check lives here' }],
  checks: [{ command: 'npm test', ok: true }, { command: 'npm run prove', ok: false, detail: 'standalone proof: 2 failures' }],
  decisions: [{ what: 'Keep the POSIX path check', why: 'the inode check already covers the hard link' }]
}

describe('checkpoint payload', () => {
  it('accepts a bounded handoff and trims it', () => {
    const parsed = parseCheckpoint(full)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.next).toBe('Run the Linux sandbox suite.')
    expect(parsed.value.done).toHaveLength(1)
  })

  it('refuses a handoff with nothing in it', () => {
    expect(parseCheckpoint({})).toMatchObject({ ok: false })
    expect(parseCheckpoint({ summary: 'x'.repeat(1_201) })).toMatchObject({ ok: false })
    expect(parseCheckpoint({ next: 'x'.repeat(501) })).toMatchObject({ ok: false })
  })

  it('drops an unusable entry instead of the whole record', () => {
    const parsed = parseCheckpoint({ summary: 's', files: [{ path: '' }, { path: 'a.ts', why: 'why' }] })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.files).toEqual([{ path: 'a.ts', why: 'why' }])
  })

  it('records the slice and why the checkpoint was written', async () => {
    const emitted: { type: string; payload: unknown }[] = []
    const tool = checkpointTool({ emit: (type, payload) => void emitted.push({ type, payload }) }, () => 3)
    const result = await tool.execute(full)
    expect(result).toContain('slice 3')
    expect(emitted).toHaveLength(1)
    expect(runEventPayloadSchemas.checkpoint.safeParse((emitted[0].payload as { slice?: unknown })).success).toBe(true)
    expect(emitted[0].payload).toMatchObject({ slice: 3, reason: 'requested' })
  })

  it('reads the latest checkpoint back from a run', () => {
    const event = (sequence: number, payload: unknown): RunEvent => ({ id: `e${sequence}`, runId: 'r', sessionId: 's', sequence, timestamp: 't', type: 'checkpoint', payload })
    const latest = checkpointOf([event(1, { summary: 'first', slice: 1, reason: 'budget' }), event(2, { summary: 'second', next: 'Run the suite', slice: 2, reason: 'stuck' })])
    expect(latest?.summary).toBe('second')
    expect(describeCheckpoint(latest!)).toContain('Next step')
    expect(ackCheckpoint(latest!)).toContain('slice 2')
  })
})
