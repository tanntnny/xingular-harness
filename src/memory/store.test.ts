import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { ensureLayout, ensureProjectNamespace, importSource, isSkeleton, listSources, locate, namespaceDir, parsePage, projectNamespaceOf, revisionsDir, serializePage, wikiDir } from './store'

const temp = () => mkdtempSync(join(tmpdir(), 'harness-store-'))

test('every project has a links page that starts as a map and is never replaced', () => {
  const root = temp()
  ensureLayout(root)
  ensureProjectNamespace(root, 'app', 'App')
  const links = join(wikiDir(root), 'projects/app/links.md')
  const text = readFileSync(links, 'utf8')
  const page = parsePage(text, wikiDir(root), links)!
  expect([page.frontmatter.id, page.frontmatter.type]).toEqual(['app-links', 'reference'])
  expect(page.body).toContain('one line each')
  expect(page.body).toContain('do not copy')
  expect(isSkeleton(page.location)).toBe(true)
  // The agent's or user's entries survive the next start, which runs this for every project.
  writeFileSync(links, text.replace('Nothing recorded yet.', '- docs/specs/product.md: what the app is for'))
  ensureProjectNamespace(root, 'app', 'App')
  expect(readFileSync(links, 'utf8')).toContain('docs/specs/product.md')
})

test('derives paths and namespaces from file locations', () => {
  const wiki = '/data/wiki'
  expect(locate(wiki, '/data/wiki/projects/xingular-agent/design/arch.md')).toEqual({ path: '/projects/xingular-agent/design/arch', namespace: '/projects/xingular-agent' })
  expect(locate(wiki, '/data/wiki/library/tauri.md').namespace).toBe('/library')
  expect(locate(wiki, '/data/wiki/home.md')).toEqual({ path: '/home', namespace: '/' })
  expect(namespaceDir(wiki, '/projects/xingular-agent')).toBe('/data/wiki/projects/xingular-agent')
  expect(namespaceDir(wiki, '/')).toBe('/data/wiki/library')
  expect(namespaceDir(wiki, '/docs/guides')).toBe('/data/wiki/library/guides')
  expect(() => namespaceDir(wiki, '/projects/../x')).toThrow()
  expect(() => namespaceDir(wiki, '/facts')).toThrow()
  expect(projectNamespaceOf('/projects/a/b')).toBe('/projects/a')
  expect(projectNamespaceOf('/library')).toBeNull()
})

test('imports each source once and versions replacements', () => {
  const root = temp()
  ensureLayout(root)
  const wiki = wikiDir(root)
  const first = importSource(wiki, 'notes.md', Buffer.from('one'))
  expect(importSource(wiki, 'notes.md', Buffer.from('one')).id).toBe(first.id)
  const second = importSource(wiki, 'notes.md', Buffer.from('two'))
  expect(second.version).toBe(2)
  expect(second.previousId).toBe(first.id)
  expect(listSources(wiki)).toHaveLength(2)
})

test('round-trips frontmatter and drops legacy scope', () => {
  const text = '---\nid: a\ntitle: A\ntype: concept\nscope: personal\nsourceIds:\n- src-1\n---\n\nBody\n'
  const page = parsePage(text, '/w', '/w/library/a.md')!
  const serialized = serializePage(page.frontmatter, page.body)
  expect(serialized).not.toContain('scope')
  const reparsed = parsePage(serialized, '/w', '/w/library/a.md')!
  expect(reparsed.frontmatter.sourceIds).toEqual(['src-1'])
  expect(reparsed.body.trim()).toBe('Body')
})

test('registry ids get revision folders', () => {
  expect(revisionsDir('/w', 'skills/review')).toBe('/w/revisions/skills--review')
  expect(() => revisionsDir('/w', '../x')).toThrow()
})
