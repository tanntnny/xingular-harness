import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { dataRoot, writeWiki } from '../../tests/helpers'
import { closeIndex } from '../core/index'
import * as blocks from './blocks'
import { readManifest, snapshot, wikiDir } from './store'
import { resolveEntry, restore, scan } from './wiki'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(closeIndex))
const setup = (): string => {
  const root = dataRoot()
  roots.push(root)
  return root
}

test('resolves pages, memories and registry items', () => {
  const root = setup()
  writeWiki(root, 'projects/app/arch.md', '---\nid: arch\ntitle: Architecture\ntype: concept\n---\n\nTauri.\n')
  writeWiki(root, 'facts/pnpm.md', '---\nid: pnpm\ntitle: Use pnpm\nkind: preference\n---\n\nUse pnpm.\n')
  mkdirSync(join(root, 'registry/skills/review'), { recursive: true })
  writeFileSync(join(root, 'registry/skills/review/SKILL.md'), '---\nname: review\ndescription: Review code\n---\n\nSteps.\n')
  expect(resolveEntry(root, 'arch').kind).toBe('page')
  expect(resolveEntry(root, '/projects/app/arch').kind).toBe('page')
  expect(resolveEntry(root, 'pnpm').kind).toBe('memory')
  expect(resolveEntry(root, 'skills/review').kind).toBe('registry')
  expect(() => resolveEntry(root, 'missing')).toThrow()
  const kinds = scan(root).entries.map((entry) => entry.kind)
  for (const kind of ['page', 'memory', 'skill']) expect(kinds).toContain(kind)
  blocks.ensureUser(wikiDir(root))
  expect(scan(root).entries.some((entry) => entry.kind === 'block' && entry.id === 'blocks/shared/user' && entry.entryType === 'shared')).toBe(true)
})

test('restores registry items through revisions', () => {
  const root = setup()
  mkdirSync(join(root, 'registry/rules'), { recursive: true })
  const file = join(root, 'registry/rules/style.md')
  writeFileSync(file, 'Use tabs.\n')
  const wiki = wikiDir(root)
  const first = snapshot(wiki, 'rules/style', 'Use tabs.\n', 'user', 'Original')
  writeFileSync(file, 'Use spaces.\n')
  restore(root, 'rules/style', first.id)
  expect(readFileSync(file, 'utf8')).toBe('Use tabs.\n')
  expect(readManifest(wiki, 'rules/style')).toHaveLength(3)
})
