import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { Bus } from '../core/bus'
import { Approvals, grant } from './approvals'

const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

function state() {
  const folder = mkdtempSync(join(tmpdir(), 'harness-approvals-'))
  folders.push(folder)
  const bus = new Bus()
  return { folder, approvals: new Approvals(folder, bus) }
}

describe('standing approval policy', () => {
  it('loads old files with no global tool grants', () => {
    const { folder, approvals } = state()
    writeFileSync(join(folder, 'approvals.json'), JSON.stringify({ auto: { pi: true }, remembered: { old: ['write'] } }))

    expect(approvals.read()).toEqual({ auto: { pi: true }, globalTools: {}, remembered: { old: ['write'] } })
  })

  it('persists a profile-wide tool grant, while read-only and other profiles stay isolated', () => {
    const { folder, approvals } = state()
    approvals.allowTool('pi', 'bash')
    const policy = approvals.read()

    expect(policy.globalTools).toEqual({ pi: ['bash'] })
    expect(grant(policy, 'pi', 'terminal-one', 'bash')).toBe('remembered')
    expect(grant(policy, 'pi', 'terminal-two', 'bash')).toBe('remembered')
    expect(grant(policy, 'chat', 'terminal-two', 'bash')).toBeNull()
    expect(grant(policy, 'pi', 'terminal-two', 'bash', { readOnly: true })).toBeNull()
    expect(JSON.parse(readFileSync(join(folder, 'approvals.json'), 'utf8'))).toMatchObject({ globalTools: { pi: ['bash'] } })
  })

  it('revokes a global tool grant without changing the full switch or session grants', () => {
    const { approvals } = state()
    approvals.setAuto('pi', true)
    approvals.remember('one-session', 'write')
    approvals.allowTool('pi', 'bash')

    expect(approvals.revokeTool('pi', 'bash')).toEqual({ auto: { pi: true }, globalTools: {}, remembered: { 'one-session': ['write'] } })
    expect(approvals.read().globalTools).toEqual({})
  })
})
