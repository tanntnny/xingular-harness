import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { load, save, set } from '../plugins/attachments'
import { builtinConnections, REA_CONNECTION_ID, reaLauncher, reaRuntimeSupported } from './builtinConnections'

describe('bundled REA connector', () => {
  it('is off by default and follows scoped plugin attachment and timeout settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'rea-scope-'))
    expect(builtinConnections(root, {})).toEqual([])
    const choices = load(root)
    set(choices, ['rea'], { projectId: 'one' }, true, false)
    choices.settings.rea = { callTimeoutSeconds: 900 }
    save(root, choices)
    expect(builtinConnections(root, { projectId: 'one' })).toMatchObject([{ id: REA_CONNECTION_ID, callTimeoutSeconds: 900, readTools: [] }])
    expect(builtinConnections(root, { projectId: 'other' })).toEqual([])
    set(choices, ['rea'], { agentId: 'excluded' }, false, false)
    save(root, choices)
    expect(builtinConnections(root, { projectId: 'one', agentId: 'excluded' })).toEqual([])
  })

  it('finds the matching upstream launcher and enforces the upstream Node ranges', () => {
    if (reaLauncher()) expect(reaLauncher()).toContain('rea-agents/scripts/rea.mjs')
    for (const version of ['22.23.4', '24.22.1', '26.12.1', '27.0.0']) expect(reaRuntimeSupported(version), version).toBe(true)
    for (const version of ['22.23.3', '23.0.0', '24.22.0', '25.0.0', '26.8.2']) expect(reaRuntimeSupported(version), version).toBe(false)
  })
})
