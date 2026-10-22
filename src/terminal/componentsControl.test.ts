import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import { headTree, lineage, seed, versionRecord } from '../tree/store'
import { rootWithProject, writeFile } from '../../tests/helpers'
import { SOCKET_ENV, TOKEN_ENV, socketCall, type SocketConnection } from './client'

const open: Harness[] = []
afterEach(async () => { for (const harness of open.splice(0)) await harness.close() })

async function setup(scope: string | null = 'components-scope') {
  const root = rootWithProject()
  const stateDir = mkdtempSync(join(tmpdir(), 'terminal-components-'))
  writeFile(join(root, 'registry/skills/review/SKILL.md'), '---\nname: review\ndescription: Review a change.\n---\nCheck the diff.\n')
  writeFile(join(root, 'registry/prompts/outline.md'), '---\nname: Outline\ndescription: Draft an outline.\n---\nWrite headings.\n')
  writeFile(join(root, 'registry/rules/testing.md'), '---\nname: Testing\ndescription: Run tests.\n---\nRun the focused tests before shipping.\n')
  if (scope) seed(root, scope, { 'systemprompt.md': 'Review changes.\n', 'guardrails.md': '', 'memory.md': '', 'tool_guidance.md': '' })
  const harness = createHarness({ dataRoot: root, stateDir, secrets: memorySecretStore(), assets: { node: '/opt/node', cli: '/opt/harness/cli.js', piExtension: '/opt/harness/terminal-pi.js', openTui: '/opt/harness/terminal-opentui.js' } })
  open.push(harness)
  const account = harness.accounts.create('Main', 'apiKey').accounts[0]
  const launch = await harness.terminals.prepare({
    sessionId: 'component-terminal', accountId: account.id, cwd: root,
    sessionFolder: join(root, 'sessions', 'component-terminal'),
    ...(scope ? { harness: { scope } } : {})
  })
  const connection: SocketConnection = { socket: String(launch.env[SOCKET_ENV]), token: String(launch.env[TOKEN_ENV]) }
  const { key } = await socketCall<{ key: string }>(connection, 'control.claim')
  const call = <T>(method: string, params?: Record<string, unknown>) => socketCall<T>(connection, method, params ?? {}, 5_000, key)
  return { root, scope, connection, call }
}


describe('person-controlled components in a terminal', () => {
  it('lists the library, adds skills and rules as new versions, rejects prompts, and is idempotent', async () => {
    const { root, scope, connection, call } = await setup()
    await expect(socketCall(connection, 'terminal.components.list')).rejects.toMatchObject({ code: 'unauthorized' })
    const listed = await call<{ items: Array<{ id: string }>; addedIds: string[]; writable: boolean; fingerprint: string }>('terminal.components.list')
    expect(listed.items.map(item => item.id)).toEqual(['prompts/outline', 'rules/testing', 'skills/review'])
    expect(listed).toMatchObject({ addedIds: [], writable: true })

    const first = await call<{ fingerprint: string; alreadyPresent: boolean }>('terminal.components.add', { id: 'skills/review' })
    expect(first.alreadyPresent).toBe(false)
    expect(first.fingerprint).not.toBe(listed.fingerprint)
    expect(headTree(root, scope!)?.tree['skills/review/SKILL.md']).toContain('Check the diff.')
    expect(versionRecord(root, scope!, first.fingerprint)?.source).toMatchObject({ kind: 'edit', components: ['skills/review'] })

    const duplicate = await call<{ fingerprint: string; alreadyPresent: boolean }>('terminal.components.add', { id: 'skills/review' })
    expect(duplicate).toEqual({ fingerprint: first.fingerprint, alreadyPresent: true })
    const second = await call<{ fingerprint: string; alreadyPresent: boolean }>('terminal.components.add', { id: 'rules/testing' })
    expect(second.alreadyPresent).toBe(false)
    expect(headTree(root, scope!)?.tree['guardrails.md']).toContain('Run the focused tests before shipping.')
    expect(lineage(root, scope!).map(item => item.source.kind)).toEqual(['edit', 'edit', 'seed'])
    await expect(call('terminal.components.add', { id: 'prompts/outline' })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(call('terminal.components.add', { id: 'skills/missing' })).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('keeps a terminal without an attached Harness scope browse-only', async () => {
    const { call } = await setup(null)
    const listed = await call<{ writable: boolean; addedIds: string[] }>('terminal.components.list')
    expect(listed).toEqual(expect.objectContaining({ writable: false, addedIds: [] }))
    await expect(call('terminal.components.add', { id: 'skills/review' })).rejects.toMatchObject({ code: 'invalid_request' })
  })
})
