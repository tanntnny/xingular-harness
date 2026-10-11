import { expect, test } from 'vitest'

import { dataRoot } from '../../tests/helpers'
import { now } from '../core/fs'
import { appliesTo, isStale, loadMemories, parse, response, saveAsUser, type MemoryFront, type MemoryInput } from './facts'
import { readManifest, wikiDir } from './store'

test('reads legacy procedures as facts without changing their content', () => {
  const parsed = parse('---\nid: legacy\ntitle: Legacy procedure\nkind: procedure\n---\n\nFollow these steps.\n', '/tmp/legacy.md')!
  expect(parsed.front.kind).toBe('fact')
  expect(parsed.body).toBe('Follow these steps.\n')
  const value = response(dataRoot(), parsed)
  expect(value.kind).toBe('fact')
  expect(value.body).toBe('Follow these steps.\n')
})

const input = (title: string, kind: string): MemoryInput => ({ title, kind, namespace: '/', body: 'Use pnpm, not npm.', confidence: 'high', status: 'active' })

test('saves, validates and revisions memories', () => {
  const wiki = wikiDir(dataRoot())
  const saved = saveAsUser(wiki, input('Package manager', 'preference'))
  expect(saved.id).toBe('package-manager')
  expect(saved.sourceIds).toEqual(['user'])
  saveAsUser(wiki, { ...input('Package manager', 'preference'), id: 'package-manager', body: 'Use pnpm everywhere.' })
  expect(readManifest(wiki, 'package-manager')).toHaveLength(3)
  expect(() => saveAsUser(wiki, input('Bad', 'opinion'))).toThrow()
  expect(() => saveAsUser(wiki, input('Steps', 'procedure'))).toThrow()
  expect(() => saveAsUser(wiki, { ...input('Scoped', 'fact'), namespace: '/elsewhere' })).toThrow()
  expect(loadMemories(wiki)).toHaveLength(1)
})

test('applies by namespace and status', () => {
  const front: MemoryFront = { id: 'm', title: 'M', kind: 'fact', namespace: '/projects/a', sourceIds: [], confidence: 'high', status: 'active', supersedes: null, links: [], createdAt: '', updatedAt: '', observedAt: '', volatile: false }
  expect(isStale(front)).toBe(false)
  expect(isStale({ ...front, volatile: true, observedAt: '2020-01-01T00:00:00Z' })).toBe(true)
  expect(isStale({ ...front, volatile: true, observedAt: now() })).toBe(false)
  expect(appliesTo(front, '/projects/a')).toBe(true)
  expect(appliesTo(front, '/projects/b')).toBe(false)
  expect(appliesTo({ ...front, namespace: '/' }, null)).toBe(true)
  expect(appliesTo({ ...front, namespace: '/', status: 'archived' }, null)).toBe(false)
})
