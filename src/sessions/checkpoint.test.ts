import { describe, expect, it } from 'vitest'

import { checkpointOf, describeCheckpoint } from './checkpoint'
import { runEventPayloadSchemas, type RunEvent } from './contracts'

const event = (sequence: number, payload: unknown): RunEvent => ({ id: `e${sequence}`, runId: 'r', sessionId: 's', sequence, timestamp: 't', type: 'checkpoint', payload })

describe('checkpoint record', () => {
  it('reads the latest checkpoint back from a run', () => {
    const latest = checkpointOf([event(1, { summary: 'first', slice: 1, reason: 'budget' }), event(2, { summary: 'second', next: 'Run the suite', slice: 2, reason: 'stuck' })])
    expect(latest?.summary).toBe('second')
    expect(describeCheckpoint(latest!)).toContain('Next step: Run the suite')
  })

  it('still reads a checkpoint the model wrote before ADR-0069', () => {
    const legacy = {
      summary: 'Finished the first half of the boundary work.',
      done: [{ item: 'Hardened the sandbox', evidence: ['src/core/workspaceSandbox.ts', 'npm test'] }],
      next: 'Run the Linux sandbox suite.',
      blocked: 'No Linux runner yet.',
      files: [{ path: 'src/core/workspaceSandbox.ts', why: 'the boundary check lives here' }],
      checks: [{ command: 'npm test', ok: true }, { command: 'npm run prove', ok: false, detail: 'standalone proof: 2 failures' }],
      decisions: [{ what: 'Keep the POSIX path check', why: 'the inode check already covers the hard link' }],
      slice: 1,
      reason: 'requested'
    }
    expect(runEventPayloadSchemas.checkpoint.safeParse(legacy).success).toBe(true)
    const text = describeCheckpoint(checkpointOf([event(1, legacy)])!)
    expect(text).toContain('Done:\n- Hardened the sandbox')
    expect(text).toContain('Checks that failed:\n- npm run prove: standalone proof: 2 failures')
    expect(text).toContain('Blocked: No Linux runner yet.')
  })

  it('ignores a payload that does not parse', () => {
    expect(checkpointOf([event(1, { summary: 1 })])).toBeNull()
    expect(checkpointOf([])).toBeNull()
  })
})
