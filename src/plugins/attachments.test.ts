import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { writeJson } from '../core/fs'
import { attached, decided, describe as where, load, save, set, type Attachments } from './attachments'

const empty = (): Attachments => ({ version: 1, global: { on: [], off: [] }, agents: {}, projects: {}, settings: {} })

describe('what is switched on, and for whom', () => {
  it('follows the narrowest scope that says something', () => {
    const choices = empty()
    choices.global.on = ['skill']
    choices.projects.p1 = { on: [], off: ['skill'] }
    choices.agents.a1 = { on: ['skill'], off: [] }
    choices.agents.a2 = { on: [], off: ['other'] }
    const rows: [string, { agentId?: string; projectId?: string }, boolean | null][] = [
      ['skill', {}, true],
      ['skill', { projectId: 'p1' }, false],
      ['skill', { projectId: 'p2' }, true],
      // An agent's own choice holds in every project it works in.
      ['skill', { agentId: 'a1', projectId: 'p1' }, true],
      ['skill', { agentId: 'a2', projectId: 'p1' }, false],
      ['other', { agentId: 'a2' }, false],
      ['other', {}, null]
    ]
    for (const [id, caller, expected] of rows) expect([id, caller, decided(choices, [id], caller)]).toEqual([id, caller, expected])
    // With no entry, a thing keeps its own default.
    expect([attached(choices, ['other'], {}, true), attached(choices, ['other'], {}, false)]).toEqual([true, false])
  })

  it('lets one item of a plugin differ from the plugin', () => {
    const choices = empty()
    choices.global.off = ['package:kit']
    choices.projects.p1 = { on: ['package:kit/skill/audit'], off: [] }
    expect(attached(choices, ['package:kit/skill/audit', 'package:kit'], {}, true)).toBe(false)
    expect(attached(choices, ['package:kit/skill/audit', 'package:kit'], { projectId: 'p1' }, true)).toBe(true)
    expect(attached(choices, ['package:kit/code/guard.ts', 'package:kit'], { projectId: 'p1' }, true)).toBe(false)
  })

  it('keeps a choice only where it differs from the wider scope', () => {
    const choices = empty()
    set(choices, ['shared/code/a.ts', 'shared'], {}, false, true)
    expect(choices.global).toEqual({ on: [], off: ['shared/code/a.ts'] })
    // On again is the default, so nothing is stored.
    set(choices, ['shared/code/a.ts', 'shared'], {}, true, true)
    expect(choices.global).toEqual({ on: [], off: [] })

    set(choices, ['skills/review'], { agentId: 'a1' }, true, false)
    expect(choices.agents.a1).toEqual({ on: ['skills/review'], off: [] })
    // Switching it on everywhere and then off for the agent keeps the agent's own choice.
    set(choices, ['skills/review'], {}, true, false)
    set(choices, ['skills/review'], { agentId: 'a1' }, false, false)
    expect(choices.agents.a1).toEqual({ on: [], off: ['skills/review'] })
    set(choices, ['skills/review'], { agentId: 'a1' }, true, false)
    expect(choices.agents.a1).toEqual({ on: [], off: [] })

    // A project's choice cannot stand in for an agent's, so the agent's is kept as said.
    set(choices, ['skills/review'], { projectId: 'p1' }, false, false)
    set(choices, ['skills/review'], { agentId: 'a1' }, true, false)
    expect(choices.agents.a1.on).toEqual(['skills/review'])
    expect(where(choices, 'skills/review', false)).toEqual({ global: true, on: { agentIds: ['a1'], projectIds: [] }, off: { agentIds: [], projectIds: ['p1'] } })
  })

  it("reads the registry's earlier file until the first change, and never rewrites it", () => {
    const root = mkdtempSync(join(tmpdir(), 'attach-'))
    const legacy = join(root, 'config/registry-enabled.json')
    writeJson(legacy, { global: ['rules/tests'], personal: ['skills/old'], p1: ['skills/review'], builtinOff: ['rules/plain'] })
    const before = readFileSync(legacy, 'utf8')
    const choices = load(root)
    expect(choices.global).toEqual({ on: ['rules/tests', 'skills/old'], off: ['rules/plain'] })
    expect(choices.projects).toEqual({ p1: { on: ['skills/review'], off: [] } })
    expect(existsSync(join(root, 'config/plugin-attachments.json'))).toBe(false)

    set(choices, ['skills/review'], { agentId: 'a1' }, true, false)
    save(root, choices)
    expect(readFileSync(legacy, 'utf8')).toBe(before)
    expect(load(root)).toEqual(choices)
    // From here the earlier file is not read any more.
    writeJson(legacy, { global: [] })
    expect(load(root).global.on).toEqual(['rules/tests', 'skills/old'])
  })
})
