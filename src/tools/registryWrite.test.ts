import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import * as attachments from '../plugins/attachments'
import * as registry from '../skills/registry'
import * as store from '../memory/store'
import { registryTools } from './registryWrite'
import type { ToolSession, ToolSpec } from './types'

const open: Harness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})

function setup() {
  const harness = createHarness({
    dataRoot: mkdtempSync(join(tmpdir(), 'registry-write-data-')),
    stateDir: mkdtempSync(join(tmpdir(), 'registry-write-state-')),
    secrets: memorySecretStore()
  })
  open.push(harness)
  /** Runs one of the tools as the given agent would see it. */
  const call = (agentId: string, name: string, input: Record<string, unknown>) => {
    const session = { caller: { agentId, agentName: 'Helper', actor: 'Chat', runId: 'run-1' }, allow: [], depth: 0, cwd: harness.env.root, capabilities: { version: 1, tools: [], connectors: [], contributions: [] } } as unknown as ToolSession
    const tool = (registryTools({ harness })(session) as ToolSpec[]).find((candidate) => candidate.name === name)!
    return tool.execute(input)
  }
  return { harness, root: harness.env.root, call }
}

describe('registry_write', () => {
  it('writes a new skill on for the calling agent only, and records who wrote it', async () => {
    const { root, call } = setup()
    const reply = await call('agent-1', 'registry_write', { kind: 'skill', name: 'Release Notes', description: 'Write notes', body: 'Use short bullets.' })
    expect(reply).toContain('on for you only')
    expect(registry.list(root).some((item) => item.id === 'skills/release-notes')).toBe(true)
    expect(registry.enabledFor(root, null, 'agent-1').map((item) => item.id)).toContain('skills/release-notes')
    expect(registry.enabledFor(root, null, 'agent-2').map((item) => item.id)).not.toContain('skills/release-notes')
    expect(readFileSync(join(store.wikiDir(root), 'log.md'), 'utf8')).toContain('Helper (Chat)')
  })

  it('leaves an item others already use unchanged and sends the new text to the Inbox', async () => {
    const { root, call } = setup()
    await call('agent-1', 'registry_write', { kind: 'rule', name: 'Be brief', description: 'Keep answers short', body: 'Short answers.' })
    const choices = attachments.load(root)
    attachments.set(choices, ['rules/be-brief'], {}, true, false)
    attachments.save(root, choices)
    const path = registry.list(root).find((item) => item.id === 'rules/be-brief')!.path
    const before = readFileSync(path, 'utf8')

    const reply = await call('agent-2', 'registry_write', { kind: 'rule', name: 'Be brief', description: 'Keep answers short', body: 'Different text.' })
    expect(reply).toContain('Inbox')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('refuses a body that looks like a credential', async () => {
    const { call } = setup()
    await expect(call('agent-1', 'registry_write', { kind: 'prompt', name: 'Leak', description: 'x', body: 'key sk-ant-abc123' })).rejects.toThrow(/credential/)
  })

  it('rejects an unknown kind', async () => {
    const { call } = setup()
    await expect(call('agent-1', 'registry_write', { kind: 'page', name: 'x', description: 'x', body: 'x' })).rejects.toThrow(/skill, prompt, or rule/)
  })
})

describe('plugin_write', () => {
  const skillOnly = { name: 'Notes Helper', description: 'Adds a note skill', files: [{ path: 'skills/notes/SKILL.md', content: '---\nname: notes\ndescription: Notes\n---\n\nTake notes.' }] }

  it('writes a plugin that is on for the calling agent only', async () => {
    const { root, call } = setup()
    const reply = await call('agent-1', 'plugin_write', skillOnly)
    expect(reply).toContain('on for you only')
    const choices = attachments.load(root)
    expect(attachments.attached(choices, ['package:notes-helper'], { agentId: 'agent-1' }, false)).toBe(true)
    expect(attachments.attached(choices, ['package:notes-helper'], { agentId: 'agent-2' }, false)).toBe(false)
  })

  it('trusts the code of a plugin that runs code, and only once it is written', async () => {
    const { harness, call } = setup()
    expect(harness.plugins.trust.list()).toEqual([])
    const reply = await call('agent-1', 'plugin_write', {
      name: 'Memory Mirror',
      description: 'Mirrors saved facts',
      extends: ['memory'],
      files: [{ path: 'hooks.mjs', content: 'export default function () {}' }]
    })
    expect(reply).toContain('trusted')
    expect(harness.plugins.trust.list()).toHaveLength(1)
  })

  it('refuses a plugin folder that already exists', async () => {
    const { call } = setup()
    await call('agent-1', 'plugin_write', skillOnly)
    await expect(call('agent-1', 'plugin_write', skillOnly)).rejects.toThrow(/already a plugin folder/)
  })
})
