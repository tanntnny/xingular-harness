import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { writeJson } from '../core/fs'
import { setLogSink, type Notice } from '../core/bus'
import { createHarness, type Harness } from '../harness'
import type { PiSessionLike } from '../sessions/runner'
import * as blocks from './blocks'
import { findMemory } from './facts'
import { prompt, runMaintenance, toolNames, type MaintainerFactory, type MaintenanceRequest } from './maintainer'
import { chatUpdatesPaused, fullBlocks } from './maintenance'
import { listInbox } from './operations'
import { wikiDir } from './store'

const request: MaintenanceRequest = { jobId: 'job-1', namespace: '/library', trigger: { kind: 'ingest', sourceId: 'src-1', sourceName: 'notes.md', text: 'We chose Tauri.' }, pages: [], index: '# Index' }
const input = { cwd: '/tmp', product: 'Xingular Agent', account: { id: 'a', provider: 'pi' as const, label: 'A', env: {}, configDir: '/tmp', sharing: [] }, runtime: async () => ({}) as never }

describe('the maintainer session', () => {
  it('collects proposals and flags without writing anything itself', async () => {
    let prompted = ''
    const factory: MaintainerFactory = async ({ collect }) => ({
      prompt: async (text) => {
        prompted = text
        collect.page({ title: 'Use Tauri', type: 'decision', body: 'We use Tauri.', sourceRefs: [{ kind: 'source', ref: 'src-1' }], links: [] })
        collect.memory({ title: 'Prefers Tauri', kind: 'preference', body: 'Use Tauri for desktop apps.', namespace: '/', sourceRefs: [{ kind: 'source', ref: 'src-1' }] })
        collect.flag({ claim: 'Electron is slow', kind: 'uncited', reason: 'No source' })
      },
      dispose: () => undefined,
      error: () => null
    })
    const result = await runMaintenance(request, input, factory)
    expect(prompted).toContain('src-1')
    expect(prompted).toContain('Namespace for this job: /library')
    expect(result.pages).toHaveLength(1)
    expect(result.memories[0]).toMatchObject({ kind: 'preference', namespace: '/' })
    expect(result.flags[0]).toMatchObject({ kind: 'uncited' })
  })

  it('gives a run its blocks and page bodies, and each job only its tools', async () => {
    const block = { id: 'blocks/shared/user', label: 'user', description: 'About the user.', limit: 2000, body: 'Likes pnpm.' }
    const run: MaintenanceRequest = { ...request, trigger: { kind: 'run', runId: 'run-1', transcript: 'User: hi\nAssistant: hello' }, pages: [{ id: 'shell', title: 'Shell', type: 'decision', summary: 'Tauri', body: 'We use Tauri.' }], blocks: [block] }
    const text = prompt(run)
    expect(text).toContain('<block id="blocks/shared/user" label="user" chars="11/2000">')
    expect(text).toContain('<page id="shell" title="Shell">\nWe use Tauri.')
    expect(text).toContain('Settled run run-1 transcript')
    expect(prompt({ ...request, trigger: { kind: 'consolidate' }, blocks: [block] })).toBe('Memory blocks to condense:\n\n<block id="blocks/shared/user" label="user" chars="11/2000">\nAbout the user.\n---\nLikes pnpm.\n</block>')
    expect(toolNames('run')).toEqual(['rethink_block', 'propose_memory', 'propose_page', 'flag_claim'])
    expect(toolNames('ingest')).not.toContain('rethink_block')
    expect(toolNames('consolidate')).toEqual(['rethink_block'])
  })

  it('reports provider failures', async () => {
    const factory: MaintainerFactory = async () => ({ prompt: async () => undefined, dispose: () => undefined, error: () => 'quota exceeded' })
    await expect(runMaintenance(request, input, factory)).rejects.toMatchObject({ code: 'provider_error' })
  })
})

const open: Harness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})

function setup(factory: MaintainerFactory) {
  const reply: PiSessionLike = {
    sessionId: 'native',
    subscribe: (listener) => {
      emit = listener as never
      return () => undefined
    },
    prompt: async () => emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'We decided to use Tauri. I prefer small commits.' }] } }),
    sendCustomMessage: async () => undefined,
    abort: async () => undefined,
    dispose: () => undefined
  }
  let emit: (event: unknown) => void = () => undefined
  const harness = createHarness({ dataRoot: mkdtempSync(join(tmpdir(), 'harness-maint-data-')), stateDir: mkdtempSync(join(tmpdir(), 'harness-maint-state-')), secrets: memorySecretStore(), sessionFactory: async () => reply, maintainerFactory: factory })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')
  const notices: Notice[] = []
  harness.bus.on((notice) => void notices.push(notice))
  const turn = (id: string) => harness.sessions.run({ run: { id, sessionId: 'nora' }, cwd: harness.env.root, sessionDir: join(harness.env.root, 'history'), text: 'Which shell do we use?', caller: { agentId: 'nora', agentName: 'Nora', actor: 'Chat' }, tools: { allow: [] } })
  return { harness, notices, turn, wiki: wikiDir(harness.env.root) }
}

describe('the memory lifecycle', () => {
  it('a settled run is consolidated: quoted changes apply, invented ones wait, and the session never writes', async () => {
    let seen: { kind: string; text: string } | null = null
    const { harness, notices, turn, wiki } = setup(async ({ kind, collect }) => ({
      prompt: async (text) => {
        seen = { kind, text }
        collect.memory({ title: 'Small commits', kind: 'preference', body: 'Prefer small commits.', confidence: 'high', sourceRefs: [{ kind: 'run', ref: 'run-1', excerpt: 'I prefer small commits' }] })
        collect.memory({ title: 'Invented', kind: 'fact', body: 'Never said.', confidence: 'high', sourceRefs: [{ kind: 'run', ref: 'run-1', excerpt: 'something never said at all' }] })
        collect.block({ block: 'blocks/agents/nora/notes', body: 'The shell is Tauri.', sourceRefs: [{ kind: 'run', ref: 'run-1', excerpt: 'We decided to use Tauri' }] })
        collect.page({ title: 'A new page', type: 'concept', body: 'From one run.', sourceRefs: [{ kind: 'run', ref: 'run-1', excerpt: 'We decided to use Tauri' }], links: [] })
      },
      dispose: () => undefined,
      error: () => null
    }))
    await turn('run-1')
    await new Promise((resolve) => setTimeout(resolve, 30))
    await harness.maintenance.settled()
    expect(seen!.kind).toBe('run')
    expect(seen!.text).toContain('Settled run run-1 transcript:\n\nUser: Which shell do we use?\nAssistant: We decided to use Tauri.')
    expect(seen!.text).toContain('<block id="blocks/agents/nora/notes" label="notes"')
    expect(findMemory(wiki, 'small-commits').front).toMatchObject({ namespace: '/', sourceIds: ['run:run-1'] })
    expect(() => findMemory(wiki, 'invented')).toThrow()
    expect(blocks.find(wiki, 'blocks/agents/nora/notes').body).toBe('The shell is Tauri.')
    // One run is an episode: it never becomes a page by itself.
    expect(listInbox(wiki).map((item) => item.kind).sort()).toEqual(['applied', 'unresolved', 'unresolved'])
    expect(notices.some((notice) => notice.type === 'wiki.maintenance' && String(notice.detail).includes('2 parked'))).toBe(true)
    expect(readFileSync(join(wiki, 'log.md'), 'utf8')).toContain('Sleep-time · run run-1')
    // A person can undo the whole consolidation as one operation.
    harness.maintenance.undoOperation(listInbox(wiki).find((item) => item.operationId)!.operationId!)
    expect(blocks.find(wiki, 'blocks/agents/nora/notes').body).toBe('')
  })

  it('skips a run that settings exclude, and a paused conversation', async () => {
    let jobs = 0
    const { harness, turn } = setup(async () => ({ prompt: async () => void (jobs += 1), dispose: () => undefined, error: () => null }))
    writeJson(join(harness.env.root, 'config/settings.json'), { excludedSourceIds: ['run-1'] })
    await turn('run-1')
    await new Promise((resolve) => setTimeout(resolve, 30))
    await harness.maintenance.settled()
    writeJson(join(harness.env.root, 'config/settings.json'), { autoMaintenanceChat: false })
    await turn('run-2')
    await new Promise((resolve) => setTimeout(resolve, 30))
    await harness.maintenance.settled()
    expect(jobs).toBe(0)
    expect([chatUpdatesPaused({}), chatUpdatesPaused({ autoMaintenanceChat: true }), chatUpdatesPaused({ autoMaintenanceChat: false })]).toEqual([false, false, true])
  })

  it('a code run outside any project is not maintained, and it leaves no log line', async () => {
    const lines: string[] = []
    setLogSink((text) => void lines.push(text))
    try {
      let jobs = 0
      const { harness } = setup(async () => ({ prompt: async () => void (jobs += 1), dispose: () => undefined, error: () => null }))
      await harness.sessions.run({ run: { id: 'code-1', sessionId: 'nora', mode: 'code' },cwd: harness.env.root, sessionDir: join(harness.env.root, 'history'), text: 'Which shell do we use?', caller: { agentId: 'nora', agentName: 'Nora', actor: 'Code' }, tools: { allow: [] } })
      await new Promise((resolve) => setTimeout(resolve, 30))
      await harness.maintenance.settled()
      expect(jobs).toBe(0)
      expect(lines.filter((line) => line.includes('maintenance'))).toEqual([])
    } finally {
      setLogSink(null)
    }
  })

  it('an imported source is read once and its proposals are checked against its text', async () => {
    const { harness, wiki } = setup(async ({ kind, collect }) => ({
      prompt: async () => {
        expect(kind).toBe('ingest')
        const source = (await import('./store')).listSources(wiki)[0]
        collect.page({ id: 'shell', title: 'Shell', type: 'decision', body: 'We use Tauri.', sourceRefs: [{ kind: 'source', ref: source.id, excerpt: 'we chose Tauri for the shell' }], links: [] })
        collect.page({ id: 'rumor', title: 'Rumor', type: 'concept', body: 'Not in the source.', sourceRefs: [{ kind: 'source', ref: source.id, excerpt: 'Electron is faster than everything' }], links: [] })
      },
      dispose: () => undefined,
      error: () => null
    }))
    harness.maintenance.ingest('notes.md', Buffer.from('After the review we chose Tauri for the shell.'))
    await harness.maintenance.settled()
    expect(readFileSync(join(wiki, 'library/shell.md'), 'utf8')).toContain('We use Tauri.')
    const parked = listInbox(wiki).find((item) => item.payload !== undefined)!
    expect(parked.title).toContain('Rumor')
    // The user is the authority when they accept what was parked.
    expect(harness.maintenance.acceptInboxItem(parked.id)).toContain('created')
    expect(readFileSync(join(wiki, 'library/rumor.md'), 'utf8')).toContain('user:accepted')
  })

  it('condenses a block that is close to its limit once nothing else is happening, and only to something shorter', async () => {
    const harness = createHarness({
      dataRoot: mkdtempSync(join(tmpdir(), 'harness-maint-data-')),
      stateDir: mkdtempSync(join(tmpdir(), 'harness-maint-state-')),
      secrets: memorySecretStore(),
      idleMs: 20,
      maintainerFactory: async ({ kind, collect }) => ({ prompt: async () => void (kind === 'consolidate' && collect.block({ block: 'blocks/shared/user', body: 'Uses pnpm.' })), dispose: () => undefined, error: () => null })
    })
    open.push(harness)
    harness.accounts.create('Main', 'apiKey')
    const wiki = wikiDir(harness.env.root)
    const user = blocks.ensureUser(wiki)
    writeFileSync(user.path, blocks.serializeBlock({ ...user.front, limit: 60 }, 'Likes pnpm. Likes pnpm a lot. Uses pnpm everywhere, always.'))
    expect(fullBlocks(wiki, new Set())).toEqual(['blocks/shared/user'])
    await new Promise((resolve) => setTimeout(resolve, 120))
    await harness.maintenance.settled()
    expect(blocks.find(wiki, 'blocks/shared/user').body).toBe('Uses pnpm.')
    const tried = new Set<string>()
    expect(fullBlocks(wiki, tried)).toEqual([])
  })
})
