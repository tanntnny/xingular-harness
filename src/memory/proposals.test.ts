import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { dataRoot } from '../../tests/helpers'
import * as blocks from './blocks'
import { findMemory } from './facts'
import { listInbox, undo } from './operations'
import { accept, apply, captureHashes, parkRegistryProposal, parseProposalSet, quotedIn, type Evidence, type Trigger } from './proposals'
import { readManifest, wikiDir } from './store'

function setup(): { root: string; wiki: string } {
  const root = dataRoot()
  return { root, wiki: wikiDir(root) }
}

const proposal = (id: string, refs: [string, string][]) => ({
  id,
  title: `Title ${id}`,
  type: 'decision',
  body: `Body of ${id}.`,
  sourceRefs: refs.map(([kind, ref]) => ({ kind, ref, excerpt: 'we decided to use Tauri' }))
})

const memoryProposal = (id: string, confidence: string) => ({
  id,
  title: `Memory ${id}`,
  kind: 'preference',
  body: 'Prefer small commits.',
  confidence,
  sourceRefs: [{ kind: 'run', ref: 'run-1', excerpt: 'prefer small commits' as string | undefined }]
})

/** What run-1 recorded: the text excerpts are checked against. */
const ev = (): Evidence => ({ runText: 'User: which shell?\nAssistant: We decided to use   Tauri. I prefer small commits.\n' })
const agent = (): Trigger => ({ kind: 'agent', runId: 'run-1', actor: 'Chat' })
const set = (value: unknown) => parseProposalSet(value)
const inboxItems = (wiki: string) => listInbox(wiki).sort((left, right) => (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0))

test('applies cited pages into the namespace and parks uncited ones', () => {
  const { wiki } = setup()
  const withKey = { ...proposal('with-key', [['run', 'run-1']]), body: 'token sk-ant-abc123' }
  const proposals = set({ pages: [proposal('use-tauri', [['run', 'run-1']]), proposal('rumor', [['run', 'other-run']]), withKey], flags: [{ claim: 'x', kind: 'uncited', reason: 'none' }] })
  const outcome = apply(wiki, '/projects/app', agent(), proposals, new Map(), ev())
  const operation = outcome.operation!
  expect(operation.pages).toHaveLength(1)
  expect(outcome.parked).toBe(2)
  expect(readFileSync(join(wiki, 'projects/app/use-tauri.md'), 'utf8')).toContain('run:run-1')
  expect(readFileSync(join(wiki, 'index.md'), 'utf8')).toContain('[/projects/app](projects/app/index.md) — 1 page')
  expect(readFileSync(join(wiki, 'projects/app/index.md'), 'utf8')).toContain('- [Title use-tauri](use-tauri.md) (decision, `use-tauri`)')
  expect(readFileSync(join(wiki, 'log.md'), 'utf8')).toContain(operation.id)
  const items = inboxItems(wiki)
  expect(items.map((item) => item.kind)).toEqual(['applied', 'blocked', 'unresolved', 'unresolved'])
  // The parked uncited page can be accepted; the credential one carries no payload.
  expect(items.some((item) => item.kind === 'unresolved' && item.payload !== undefined)).toBe(true)
  expect(items.every((item) => item.kind !== 'blocked' || item.payload === undefined)).toBe(true)
})

test('memories apply with evidence and low confidence waits for acceptance', () => {
  const { root, wiki } = setup()
  const outcome = apply(wiki, '/projects/app', { kind: 'agent', runId: 'run-1', actor: 'Code' }, set({ memories: [memoryProposal('small-commits', 'high'), memoryProposal('maybe', 'low')] }), new Map(), ev())
  expect(outcome.operation!.pages).toHaveLength(1)
  const saved = findMemory(wiki, 'small-commits')
  expect(saved.front.namespace).toBe('/projects/app')
  expect(saved.front.sourceIds).toEqual(['run:run-1'])
  expect(readManifest(wiki, 'small-commits')[0].actor).toBe('Code')
  const parked = listInbox(wiki).find((item) => item.payload !== undefined)!
  accept(root, parked.id)
  expect(findMemory(wiki, 'maybe').front.sourceIds).toContain('user:accepted')
  expect(() => accept(root, parked.id)).toThrow()
})

test('superseding memory retires the old one', () => {
  const { wiki } = setup()
  const trigger: Trigger = { kind: 'run', runId: 'run-1' }
  apply(wiki, '/library', trigger, set({ memories: [memoryProposal('old', 'high')] }), new Map(), ev())
  apply(wiki, '/library', trigger, set({ memories: [{ ...memoryProposal('new', 'high'), supersedes: 'old' }] }), captureHashes(wiki), ev())
  expect(findMemory(wiki, 'old').front.status).toBe('superseded')
  expect(findMemory(wiki, 'new').front.supersedes).toBe('old')
})

test('registry proposals always wait and accept writes a revision', () => {
  const { root, wiki } = setup()
  const id = parkRegistryProposal(wiki, { kind: 'agent', runId: null, actor: 'Chat' }, { kind: 'skill', name: 'Release notes', description: 'Write release notes', body: 'Steps.', reason: '' })
  expect(id).toBe('skills/release-notes')
  expect(existsSync(join(root, 'registry/skills/release-notes'))).toBe(false)
  accept(root, listInbox(wiki).find((item) => item.kind === 'proposed')!.id)
  const text = readFileSync(join(root, 'registry/skills/release-notes/SKILL.md'), 'utf8')
  expect(text).toContain('Write release notes')
  expect(text).toContain('Steps.')
  expect(readManifest(wiki, 'skills/release-notes')).toHaveLength(1)
})

test('never overwrites a page edited during the job', () => {
  const { wiki } = setup()
  apply(wiki, '/library', agent(), set({ pages: [proposal('p', [['run', 'run-1']])] }), new Map(), ev())
  const captured = captureHashes(wiki)
  const path = join(wiki, 'library/p.md')
  appendFileSync(path, '\nUser edit.\n')
  const outcome = apply(wiki, '/library', agent(), set({ pages: [proposal('p', [['run', 'run-1']])] }), captured, ev())
  expect(outcome.operation).toBeNull()
  expect(readFileSync(path, 'utf8')).toContain('User edit.')
})

test('undo restores through new revisions', () => {
  const { wiki } = setup()
  apply(wiki, '/library', agent(), set({ pages: [proposal('p', [['run', 'run-1']])] }), new Map(), ev())
  const path = join(wiki, 'library/p.md')
  const original = readFileSync(path, 'utf8')
  const second = apply(wiki, '/library', agent(), set({ pages: [{ ...proposal('p', [['run', 'run-1']]), body: 'Changed body.' }] }), captureHashes(wiki), ev()).operation!
  const revisionsBefore = readManifest(wiki, 'p').length
  undo(wiki, second.id)
  expect(readFileSync(path, 'utf8')).toBe(original)
  expect(readManifest(wiki, 'p').length).toBeGreaterThan(revisionsBefore)
  expect(() => undo(wiki, second.id)).toThrow()
})

test('a run reference counts only with an excerpt found in the run', () => {
  expect(quotedIn('We decided to use\n  Tauri.', 'decided to use tauri')).toBe(true)
  expect(quotedIn('We decided to use Tauri.', 'Tauri')).toBe(false)
  expect(quotedIn('We decided to use Tauri.', 'decided to use Electron')).toBe(false)
  expect(quotedIn(null, 'decided to use tauri')).toBe(false)
  const { wiki } = setup()
  const bare = { ...memoryProposal('bare', 'high'), sourceRefs: [{ kind: 'run', ref: 'run-1' }] }
  const invented = { ...memoryProposal('invented', 'high'), sourceRefs: [{ kind: 'run', ref: 'run-1', excerpt: 'the user loves large commits' }] }
  const outcome = apply(wiki, '/library', agent(), set({ memories: [bare, invented, memoryProposal('quoted', 'high')] }), new Map(), ev())
  expect(outcome.parked).toBe(2)
  expect(findMemory(wiki, 'quoted').front.id).toBe('quoted')
  expect(() => findMemory(wiki, 'bare')).toThrow()
  expect(() => findMemory(wiki, 'invented')).toThrow()
})

test('consolidating a run updates pages and blocks but creates no page', () => {
  const { wiki } = setup()
  apply(wiki, '/library', agent(), set({ pages: [proposal('shell', [['run', 'run-1']])] }), new Map(), ev())
  const user = blocks.ensureUser(wiki)
  const notes = blocks.ensureAgent(wiki, 'a1')[1]
  const quoted = (block: string, body: string, excerpt: string) => ({ block, body, sourceRefs: [{ kind: 'run', ref: 'run-1', excerpt }] })
  const proposals = set({
    pages: [{ ...proposal('shell', [['run', 'run-1']]), body: 'We use Tauri.' }, proposal('observed-in-run', [['run', 'run-1']])],
    blocks: [quoted(user.id, 'Prefers small commits.', 'I prefer small commits'), quoted(user.id, 'Made up.', 'something never said at all'), quoted(notes.id, 'Not attached.', 'I prefer small commits')]
  })
  const outcome = apply(wiki, '/library', { kind: 'run', runId: 'run-1' }, proposals, captureHashes(wiki), { ...ev(), blocks: [user.id] })
  const operation = outcome.operation!
  expect(operation.pages.map((page) => page.pageId)).toEqual(['shell', 'blocks/shared/user'])
  expect(outcome.parked).toBe(3)
  expect(existsSync(join(wiki, 'library/observed-in-run.md'))).toBe(false)
  expect(blocks.find(wiki, user.id).body).toBe('Prefers small commits.')
  expect(readManifest(wiki, user.id).at(-1)!.actor).toBe('Sleep-time')
  expect(blocks.find(wiki, notes.id).body).toBe('')
  // The whole consolidation undoes as one operation.
  undo(wiki, operation.id)
  expect(blocks.find(wiki, user.id).body).toBe('')
})

test('idle consolidation only shortens a block', () => {
  const { wiki } = setup()
  const user = blocks.ensureUser(wiki)
  writeFileSync(user.path, `${readFileSync(user.path, 'utf8')}Likes pnpm. Likes pnpm a lot. Uses pnpm everywhere.\n`)
  const evidence: Evidence = { blocks: [user.id] }
  const rewrite = (body: string) => set({ blocks: [{ block: user.id, body }] })
  const longer = apply(wiki, '/library', { kind: 'consolidate' }, rewrite('Likes pnpm. Likes pnpm a lot. Uses pnpm everywhere. Also loves yarn and npm.'), new Map(), evidence)
  expect(longer.operation).toBeNull()
  expect(longer.parked).toBe(1)
  const shorter = apply(wiki, '/library', { kind: 'consolidate' }, rewrite('Uses pnpm everywhere.'), new Map(), evidence)
  expect(shorter.operation).not.toBeNull()
  expect(blocks.find(wiki, user.id).body).toBe('Uses pnpm everywhere.')
})
