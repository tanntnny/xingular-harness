import { existsSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test } from 'vitest'

import { createHarness, type Harness } from '../harness'
import { memorySecretStore } from '../accounts/secrets'
import type { PiSessionLike } from '../sessions/runner'
import { registryTools } from '../tools/registryWrite'
import type { ToolSession } from '../tools/types'
import * as blocks from './blocks'
import { memoryEdit, propose } from './api'
import { enqueueCuration } from './curation'
import { findMemory } from './facts'
import * as registry from '../skills/registry'
import * as attachments from '../plugins/attachments'
import { wikiDir } from './store'

const opened: Harness[] = []
afterEach(async () => { for (const harness of opened.splice(0)) await harness.close() })
const self = { agentId: 'nora', agentName: 'Nora', actor: 'Chat', vaultAccess: 'self' as const, runId: 'origin' }
const curator = { agentId: 'curator', agentName: 'Curator', actor: 'Chat', vaultAccess: 'curator' as const, runId: 'review' }

function setup(): Harness {
  let emit: (event: unknown) => void = () => undefined
  const session: PiSessionLike = { sessionId: 'test-session', subscribe: listener => { emit = listener as never; return () => undefined }, prompt: async () => { emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Prefer pnpm for all builds.' }] } }) }, sendCustomMessage: async () => undefined, abort: async () => undefined, dispose: () => undefined }
  const harness = createHarness({ dataRoot: mkdtempSync(join(tmpdir(), 'curation-data-')), stateDir: mkdtempSync(join(tmpdir(), 'curation-state-')), externalMaintenance: true, secrets: memorySecretStore(), sessionFactory: async () => session, maintainerFactory: async () => { throw new Error('Hidden maintenance must not run') } })
  opened.push(harness)
  harness.accounts.create('Main', 'apiKey')
  blocks.ensureAgent(wikiDir(harness.env.root), 'nora')
  return harness
}
async function origin(harness: Harness): Promise<void> {
  await harness.sessions.run({ run: { id: 'origin', sessionId: 'nora' }, cwd: harness.env.root, sessionDir: join(harness.env.root, 'history'), text: 'Prefer pnpm for all builds.', caller: self, tools: { allow: [] } })
  await new Promise(resolve => setTimeout(resolve, 30))
}

test('normal callers directly write only their own persona and notes; standalone callers retain their prior scope', () => {
  const h = setup()
  expect(memoryEdit(h.env, self, 'memory.append', { block: 'notes', text: 'Working on release notes.' })).toContain('Updated')
  expect(() => memoryEdit(h.env, self, 'memory.append', { block: 'user', text: 'A shared preference.' })).toThrow('outside your writable memory')
  blocks.ensureAgent(wikiDir(h.env.root), 'other')
  expect(() => memoryEdit(h.env, self, 'memory.append', { block: 'blocks/agents/other/notes', text: 'Not mine.' })).toThrow()
  expect(memoryEdit(h.env, { ...self, vaultAccess: undefined }, 'memory.append', { block: 'user', text: 'Standalone scope.' })).toContain('Updated')
})

test('a shared fact is proposed without writing, then validated against its original run and applied once', async () => {
  const h = setup(); await origin(h)
  const submitted = propose(h.env, self, { kind: 'fact', title: 'Build tool', body: 'Use pnpm for builds.', confidence: 'high', sourceRefs: [{ kind: 'run', ref: 'current', excerpt: 'Prefer pnpm for all builds.' }] })
  const job = h.maintenance.jobs().find(job => job.input.kind === 'proposal')!
  expect(submitted).toContain(job.id)
  expect(() => findMemory(wikiDir(h.env.root), 'build-tool')).toThrow()
  expect(() => h.maintenance.readJob(self, job.id)).toThrow('curator capability')
  const receipt = h.maintenance.applyJob(curator, job.id, undefined, 'Preserve the stated build preference.')
  expect(receipt.status).toBe('completed')
  expect(findMemory(wikiDir(h.env.root), 'build-tool').front.sourceIds).toContain('run:origin')
  expect(h.maintenance.applyJob(curator, job.id, undefined, 'Retry receipt').receipt).toEqual(receipt.receipt)
})

test('invented evidence is parked and a read-only memory block is not rewritten', async () => {
  const h = setup(); await origin(h)
  propose(h.env, self, { kind: 'fact', title: 'Invented', body: 'Use another tool.', confidence: 'high', sourceRefs: [{ kind: 'run', ref: 'current', excerpt: 'This was never said anywhere.' }] })
  const job = h.maintenance.jobs().find(job => job.input.kind === 'proposal')!
  expect(h.maintenance.applyJob(curator, job.id, undefined, 'Review the claimed evidence').status).toBe('needs_user')
  expect(() => findMemory(wikiDir(h.env.root), 'invented')).toThrow()
  const block = blocks.find(wikiDir(h.env.root), 'blocks/agents/nora/notes')
  blocks.saveAsUser(wikiDir(h.env.root), { id: block.id, body: '', description: block.front.description, limit: 2000, readOnly: true })
  expect(() => propose(h.env, self, { kind: 'block', id: block.id, title: 'Notes', body: 'Changed.' })).toThrow('user-only')
})

test('text resources remain inactive until curated; undo restores attachments and preserves subsequent user edits', async () => {
  const h = setup()
  const tool = (await registryTools({ harness: h })({ caller: self } as ToolSession)).find(tool => tool.name === 'registry_write')!
  await tool.execute({ kind: 'skill', name: 'release-notes', description: 'Write release notes', body: 'Summarize verified changes.', reason: 'Repeated release work.' })
  const job = h.maintenance.jobs().find(job => job.input.kind === 'registry')!
  expect(registry.list(h.env.root).some(item => item.id === 'skills/release-notes')).toBe(false)
  const receipt = h.maintenance.applyJob(curator, job.id, undefined, 'Reuse the repeated release procedure.')
  expect(attachments.attached(attachments.load(h.env.root), ['skills/release-notes'], { agentId: 'nora' }, false)).toBe(true)
  h.maintenance.undoOperation(receipt.receipt!.operationId!)
  expect(registry.list(h.env.root).some(item => item.id === 'skills/release-notes')).toBe(false)
  const next = enqueueCuration(h.env.root, { kind: 'registry', caller: self, proposal: { kind: 'skill', name: 'other-notes', description: 'Notes', body: 'Write verified notes.', reason: 'Workflow improvement.' } })
  const applied = h.maintenance.applyJob(curator, next.id, undefined, 'Apply text-only improvement.')
  registry.writeItem(h.env.root, 'skill', 'other-notes', 'Notes', 'The user changed this.', 'User edit')
  expect(() => h.maintenance.undoOperation(applied.receipt!.operationId!)).toThrow('changed after')
})

test('changed target versions are escalated instead of overwritten', () => {
  const h = setup()
  registry.writeItem(h.env.root, 'skill', 'notes', 'Notes', 'Original notes.', 'Initial')
  const job = enqueueCuration(h.env.root, { kind: 'registry', caller: self, proposal: { kind: 'skill', name: 'notes', description: 'Notes', body: 'Proposed notes.', reason: 'Improve' } })
  registry.writeItem(h.env.root, 'skill', 'notes', 'Notes', 'User edits win.', 'User edit')
  expect(h.maintenance.applyJob(curator, job.id, undefined, 'Review update').status).toBe('needs_user')
  expect(registry.list(h.env.root).find(item => item.id === 'skills/notes')).toBeDefined()
})

test('executable plugins are submitted without saving, activation or trust', async () => {
  const h = setup()
  const tool = (await registryTools({ harness: h })({ caller: self } as ToolSession)).find(tool => tool.name === 'plugin_write')!
  await tool.execute({ name: 'code-change', description: 'A code plugin', files: [{ path: 'extensions/index.ts', content: 'export default () => {}' }] })
  const job = h.maintenance.jobs().find(job => job.input.kind === 'plugin')!
  expect(h.maintenance.applyJob(curator, job.id, undefined, 'Code needs trust').status).toBe('needs_user')
  expect(existsSync(join(h.env.root, 'plugins/code-change'))).toBe(false)
})

test('external jobs persist and repeated schedule occurrences are distinct; no hidden provider runs', async () => {
  const h = setup()
  const source = h.maintenance.ingest('source.txt', Buffer.from('Prefer pnpm for all builds.'))
  expect(h.maintenance.jobs().some(job => job.input.kind === 'ingest' && job.input.sourceId === source.id)).toBe(true)
  h.maintenance.enqueue({ kind: 'review', requestId: 'day-one' })
  h.maintenance.enqueue({ kind: 'review', requestId: 'day-one' })
  h.maintenance.enqueue({ kind: 'review', requestId: 'day-two' })
  expect(h.maintenance.jobs().filter(job => job.input.kind === 'review')).toHaveLength(2)
  await h.maintenance.settled()
})

test('a curator run never enqueues another completed-run maintenance job', async () => {
  const h = setup()
  await h.sessions.run({ run: { id: 'curator-run', sessionId: 'curator' }, cwd: h.env.root, sessionDir: join(h.env.root, 'curator-history'), text: 'Review maintenance.', caller: curator, tools: { allow: [] } })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(h.maintenance.jobs().some(job => job.input.kind === 'run' && job.input.runId === 'curator-run')).toBe(false)
})

test('curator prose cannot become its own evidence; original source runs can support a review', async () => {
  const h = setup(); await origin(h)
  await h.sessions.run({ run: { id: 'review', sessionId: 'curator' }, cwd: h.env.root, sessionDir: join(h.env.root, 'curator-history'), text: 'Prefer pnpm for all builds.', caller: curator, tools: { allow: [] } })
  await new Promise(resolve => setTimeout(resolve, 30))
  propose(h.env, curator, { kind: 'fact', title: 'Curator claim', body: 'A claim from the review.', confidence: 'high', sourceRefs: [{ kind: 'run', ref: 'current', excerpt: 'Prefer pnpm for all builds.' }] })
  const own = h.maintenance.jobs().find(job => job.input.kind === 'proposal')!
  expect(h.maintenance.applyJob(curator, own.id, undefined, 'Check the original evidence.').status).toBe('needs_user')
  expect(() => findMemory(wikiDir(h.env.root), 'curator-claim')).toThrow()
  const review = enqueueCuration(h.env.root, { kind: 'review', requestId: 'grounded-review' })
  const applied = h.maintenance.applyJob(curator, review.id, { memories: [{ title: 'Original preference', kind: 'preference', body: 'Prefer pnpm.', confidence: 'high', sourceRefs: [{ kind: 'run', ref: 'origin', excerpt: 'Prefer pnpm for all builds.' }] }] }, 'Retain the original recorded preference.')
  expect(applied.status).toBe('completed')
  expect(findMemory(wikiDir(h.env.root), 'original-preference').front.sourceIds).toContain('run:origin')
})


test('a failed evidence preparation remains attributed and can be rejected without rereading invalid input', () => {
  const h = setup()
  const job = enqueueCuration(h.env.root, { kind: 'consolidate', blockIds: ['missing-block'] })
  expect(() => h.maintenance.readJob(curator, job.id)).toThrow('No writable blocks')
  expect(h.maintenance.jobs().find(item => item.id === job.id)).toMatchObject({ status: 'failed', runId: 'review' })
  expect(h.maintenance.decide(curator, job.id, 'reject', 'The target no longer exists.').status).toBe('rejected')
})

test('a propose-only caller writes no memory directly, not even its own persona and notes', () => {
  const h = setup()
  const proposer = { ...self, vaultAccess: 'propose' as const }
  expect(() => memoryEdit(h.env, proposer, 'memory.append', { block: 'notes', text: 'Working on release notes.' })).toThrow('Memory changes are proposals')
  expect(() => memoryEdit(h.env, proposer, 'memory.append', { block: 'persona', text: 'I am terse.' })).toThrow('Memory changes are proposals')
  expect(propose(h.env, proposer, { kind: 'block', id: 'blocks/agents/nora/notes', title: 'Notes', body: 'Working on release notes.' })).toContain('Submitted proposal')
})

test('with the run trigger off, a settled run queues no consolidation of its own', async () => {
  let emit: (event: unknown) => void = () => undefined
  const session: PiSessionLike = { sessionId: 'quiet', subscribe: listener => { emit = listener as never; return () => undefined }, prompt: async () => { emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Prefer pnpm for all builds.' }] } }) }, sendCustomMessage: async () => undefined, abort: async () => undefined, dispose: () => undefined }
  const h = createHarness({ dataRoot: mkdtempSync(join(tmpdir(), 'curation-data-')), stateDir: mkdtempSync(join(tmpdir(), 'curation-state-')), externalMaintenance: true, maintenanceRunTrigger: false, secrets: memorySecretStore(), sessionFactory: async () => session })
  opened.push(h)
  h.accounts.create('Main', 'apiKey')
  await h.sessions.run({ run: { id: 'quiet-run', sessionId: 'nora' }, cwd: h.env.root, sessionDir: join(h.env.root, 'history'), text: 'Prefer pnpm.', caller: self, tools: { allow: [] } })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(h.maintenance.jobs().filter(job => job.input.kind === 'run')).toEqual([])
})
