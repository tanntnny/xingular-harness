import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import { saveRun } from '../sessions/runStore'
import { commit, head, seed } from '../variant/store'
import { rootWithProject } from '../../tests/helpers'
import { SOCKET_ENV, TOKEN_ENV, socketCall, type SocketConnection } from './client'

const open: Harness[] = []
afterEach(async () => { for (const harness of open.splice(0)) await harness.close() })

const base = { 'systemprompt.md': 'Fix bugs.\n', 'guardrails.md': '', 'memory.md': '', 'tool_guidance.md': 'Old tools.\n' }

async function setup() {
  const root = rootWithProject()
  const stateDir = mkdtempSync(join(tmpdir(), 'terminal-variant-'))
  const first = seed(root, 'v', base)
  const second = commit(root, 'v', { ...base, 'tool_guidance.md': 'New tools.\n', 'memory.md': 'Uses pnpm.\n' }, { kind: 'edit' })
  const harness = createHarness({ dataRoot: root, stateDir, secrets: memorySecretStore(), assets: { node: '/opt/node', cli: '/opt/harness/cli.js', piExtension: '/opt/harness/terminal-pi.js', openTui: '/opt/harness/terminal-opentui.js' } })
  open.push(harness)
  const account = harness.accounts.create('Main', 'apiKey').accounts[0]
  const launch = await harness.terminals.prepare({ sessionId: 'variant-terminal', accountId: account.id, cwd: root, sessionFolder: join(root, 'sessions', 'variant-terminal'), variant: { scope: 'v' } })
  const connection: SocketConnection = { socket: String(launch.env[SOCKET_ENV]), token: String(launch.env[TOKEN_ENV]) }
  const { key } = await socketCall<{ key: string }>(connection, 'control.claim')
  const call = <T>(method: string, params?: Record<string, unknown>) => socketCall<T>(connection, method, params ?? {}, 5_000, key)
  return { root, harness, connection, call, first: first.fingerprint, second: second.fingerprint }
}

describe('/variant and /refine in a terminal', () => {
  it('needs the control key, then lists, tags, compares, reverts and restores versions', async () => {
    const { root, connection, call, first, second } = await setup()
    await expect(socketCall(connection, 'terminal.variant.lineage')).rejects.toMatchObject({ code: 'unauthorized' })
    expect(await call('terminal.variant.state')).toMatchObject({ scope: 'v', pinned: second, head: second })

    await call('terminal.variant.tag', { name: 'seeded', version: first.slice(0, 6) })
    const lineage = await call<{ entries: Array<{ fingerprint: string; tags: string[] }> }>('terminal.variant.lineage')
    expect(lineage.entries.map((entry) => entry.tags)).toEqual([[], ['seeded']])

    const compared = await call<{ files: Array<{ path: string }> }>('terminal.variant.compare', { from: 'seeded' })
    expect(compared.files.map((file) => file.path)).toEqual(['memory.md', 'tool_guidance.md'])

    const reverted = await call<{ fingerprint: string }>('terminal.variant.revert', { from: 'seeded', components: ['c4'] })
    expect(head(root, 'v')?.fingerprint).toBe(reverted.fingerprint)
    const now = await call<{ files: Array<{ path: string; after: string | null }> }>('terminal.variant.compare', { from: second, to: 'head' })
    expect(now.files).toEqual([expect.objectContaining({ path: 'tool_guidance.md', after: 'Old tools.\n' })])

    await call('terminal.variant.restore', { version: 'seeded' })
    expect(head(root, 'v')?.fingerprint).toBe(first)
    await expect(call('terminal.variant.tag', { name: 'bad name' })).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('switches the conversation by asking its owner to resume on the chosen version', async () => {
    const { harness, call, first, second } = await setup()
    expect(await call('terminal.variant.switch', { version: second })).toMatchObject({ switching: false })
    expect(harness.terminals.takeRelaunch('variant-terminal')).toBeNull()
    expect(await call('terminal.variant.switch', { version: first })).toMatchObject({ switching: true, version: first })
    expect(harness.terminals.takeRelaunch('variant-terminal')).toMatchObject({ variantVersion: first })
  })

  it('prepares a replay of the latest request typed here, and refuses one without a snapshot', async () => {
    const { root, call } = await setup()
    const record = { resumedFromRunId: null, parentRunId: null, relation: null, terminalReason: null, projectId: null, mode: 'code', harness: 'pi', sessionType: 'terminal', sessionId: 'variant-terminal', nativeSessionId: null, workingDirectory: root, worktreeId: null, attachmentCount: 0, endedAt: null, status: 'completed', exitCode: null, handoffId: null, accountId: null, agentId: null, trigger: null, loadedSkills: [], variantScope: 'v', variantVersion: null }
    saveRun(root, { ...record, id: 'r-1', goal: 'Fix the flaky test', startedAt: '2026-10-02T00:00:00.000Z' })
    await expect(call('terminal.refine.prepare', {})).rejects.toMatchObject({ code: 'replay_unavailable' })
    saveRun(root, { ...record, id: 'r-2', goal: 'Fix the flaky test again', startedAt: '2026-10-03T00:00:00.000Z', workspaceSnapshot: { kind: 'git-snapshot', repo: root, commit: 'b'.repeat(40) } })
    const prepared = await call<{ task: { prompt: string; guidance?: string; scope: string } }>('terminal.refine.prepare', { guidance: 'how it reruns tests' })
    expect(prepared.task).toMatchObject({ prompt: 'Fix the flaky test again', guidance: 'how it reruns tests', scope: 'v' })
    await expect(call('terminal.refine.prepare', { guidance: 'raise the score' })).rejects.toMatchObject({ code: 'invalid_request' })
  })
})
