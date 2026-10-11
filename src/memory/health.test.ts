import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { dataRoot, writeFile } from '../../tests/helpers'
import { createEnv } from '../core/env'
import { now, readJson, writeJson } from '../core/fs'
import * as blocks from './blocks'
import { loadMemories } from './facts'
import { build } from './graph'
import { check } from './health'
import { run, version, WIKI_VERSION } from './migrate'
import { ensureProjectNamespace, isDir, isFile, loadPages, wikiDir } from './store'

test('reports problems across the wiki', () => {
  const root = dataRoot()
  const wiki = wikiDir(root)
  writeFileSync(join(wiki, 'library/tauri.md'), '---\nid: tauri\ntitle: Use Tauri\ntype: decision\nsourceIds: []\nlinks:\n  - toId: xingular-agent\n    type: references\n  - toId: electron\n    type: contradicts\n---\n\nWe use Tauri 2.\n')
  writeFile(join(wiki, 'projects/xingular-agent/xingular-agent.md'), '---\nid: xingular-agent\ntitle: Xingular Agent\ntype: concept\n---\n\nThe app.\n')
  writeFileSync(join(wiki, 'library/lonely.md'), '---\nid: lonely\ntitle: Lonely\ntype: concept\nsourceIds: [run:r1]\n---\n\nAlone.\n')
  writeFileSync(join(wiki, 'facts/m.md'), '---\nid: m\ntitle: M\nkind: fact\nsourceIds: [src-missing]\n---\n\nFact.\n')
  const report = check(root)
  expect(report.brokenLinks).toHaveLength(1)
  expect(report.contradictions).toHaveLength(1)
  expect(report.orphanPages).toEqual(['lonely'])
  expect([...report.missingEvidence].sort()).toEqual(['m', 'tauri', 'xingular-agent'])
  expect([report.staleFacts, report.similarTitles, report.fullBlocks]).toEqual([[], [], []])
})

test('reports stale facts, near-duplicate titles and full blocks', () => {
  const root = dataRoot()
  ensureProjectNamespace(root, 'app', 'App')
  const wiki = wikiDir(root)
  for (const [file, title] of [['a', 'Linear MCP availability observed in run a3695ebe'], ['b', 'Linear MCP availability observed in run c54c128a'], ['c', 'Release plan']]) {
    writeFileSync(join(wiki, `library/${file}.md`), `---\nid: ${file}\ntitle: ${title}\ntype: reference\nsourceIds: [user]\n---\n\nText.\n`)
  }
  writeFileSync(join(wiki, 'facts/old.md'), '---\nid: old\ntitle: Open issues\nkind: fact\nvolatile: true\nobservedAt: 2020-01-01T00:00:00Z\nsourceIds: [user]\n---\n\nThree open.\n')
  writeFileSync(join(wiki, 'facts/new.md'), `---\nid: new\ntitle: On call\nkind: fact\nvolatile: true\nobservedAt: ${now()}\nsourceIds: [user]\n---\n\nNora.\n`)
  const user = blocks.ensureUser(wiki)
  writeFileSync(user.path, blocks.serializeBlock({ ...user.front, limit: 20 }, 'Nineteen characters'))
  const report = check(root)
  expect(report.staleFacts).toEqual(['old'])
  expect(report.similarTitles).toEqual([['a', 'b']])
  expect(report.fullBlocks).toEqual(['blocks/shared/user'])
  // A project's skeleton pages start empty and unlinked without being reported.
  expect(report.orphanPages).toEqual(['a', 'b', 'c'])
  expect(report.missingEvidence).toEqual([])
})

test('graph spans namespaces, memories and registry', () => {
  const root = dataRoot()
  ensureProjectNamespace(root, 'app', 'App')
  const wiki = wikiDir(root)
  writeFileSync(join(wiki, 'projects/app/arch.md'), '---\nid: arch\ntitle: Arch\ntype: concept\nlinks:\n  - toId: skills/review\n    type: uses\n---\n\nBody.\n')
  writeFileSync(join(wiki, 'facts/m.md'), '---\nid: m\ntitle: M\nkind: fact\nnamespace: /projects/app\n---\n\nFact.\n')
  writeFile(join(root, 'registry/skills/review.md'), 'Review code.\n')
  const graph = build(createEnv(root))
  const types = new Set(graph.nodes.map((node) => node.type))
  for (const type of ['project', 'memory', 'skill'] as const) expect(types.has(type)).toBe(true)
  expect(graph.edges.some((edge) => edge.source === 'arch' && edge.target === 'skills/review')).toBe(true)
  expect(graph.edges.some((edge) => edge.source === 'm' && edge.target === 'project-app' && edge.type === 'part_of')).toBe(true)
})

function v2Layout(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-migrate-'))
  writeJson(join(root, 'projects.json'), [{ id: 'p1', name: 'Xingular Agent', slug: 'xingular-agent', rootPath: '/tmp/x', autoMaintenance: true, createdAt: '2026-01-01T00:00:00Z' }])
  writeFile(join(root, 'config/storage.json'), '{"wikiVersion":2}')
  writeFile(join(root, 'wiki/docs/observed.md'), '---\nid: observed\ntitle: Observed in run\ntype: reference\n---\n\nA run.\n')
  writeFile(join(root, 'wiki/memory/pnpm.md'), '---\nid: pnpm\ntitle: Use pnpm\nkind: preference\n---\n\nUse pnpm.\n')
  writeFile(join(root, 'wiki/log.md'), '# Maintenance log\n\n- t · user · ingest\n')
  writeFile(join(root, 'registry/rules/style.md'), 'Use spaces.\n')
  return root
}

test('version 3 starts clean and keeps the old wiki as a backup', () => {
  const root = v2Layout()
  expect(version(root)).toBe(2)
  expect(run(createEnv(root), ['a1'])).toBe(true)
  const wiki = wikiDir(root)
  expect(loadPages(wiki).every((page) => page.frontmatter.id !== 'observed')).toBe(true)
  expect(loadMemories(wiki)).toEqual([])
  for (const relative of ['blocks/shared/user.md', 'blocks/agents/a1/persona.md', 'blocks/agents/a1/notes.md', 'blocks/projects/xingular-agent/brief.md', 'projects/xingular-agent/overview.md']) expect(isFile(join(wiki, relative))).toBe(true)
  expect(isDir(join(wiki, 'library')) && isDir(join(wiki, 'facts'))).toBe(true)
  expect(isFile(join(root, 'wiki.pre-v3/docs/observed.md')) && isFile(join(root, 'wiki.pre-v3/memory/pnpm.md'))).toBe(true)
  expect(readFileSync(join(root, 'registry/rules/style.md'), 'utf8')).toBe('Use spaces.\n')
  expect(isDir(join(root, 'wiki.migrating'))).toBe(false)
  expect(version(root)).toBe(WIKI_VERSION)
  expect(run(createEnv(root))).toBe(false)
})

test('a version 2 wiki without a marker is still migrated', () => {
  const root = v2Layout()
  rmSync(join(root, 'config/storage.json'))
  expect(version(root)).toBe(2)
  expect(run(createEnv(root))).toBe(true)
  expect(isFile(join(root, 'wiki.pre-v3/docs/observed.md'))).toBe(true)
})

test('version 1 knowledge is kept as a backup and personal items become global', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-migrate-'))
  writeJson(join(root, 'projects.json'), [{ id: 'p1', name: 'Xingular Agent', rootPath: '/tmp/x', autoMaintenance: true, createdAt: '2026-01-01T00:00:00Z' }])
  writeFile(join(root, 'knowledge/personal/wiki/overview.md'), '---\nid: overview\ntitle: Mine\ntype: summary\n---\n\nMine.\n')
  writeFile(join(root, 'config/registry-enabled.json'), '{"personal":["skills/a"],"p1":["rules/b"]}')
  expect(version(root)).toBe(1)
  expect(run(createEnv(root))).toBe(true)
  expect(isDir(join(root, 'knowledge'))).toBe(false)
  expect(isFile(join(root, 'knowledge.pre-v2/personal/wiki/overview.md'))).toBe(true)
  expect(isFile(join(wikiDir(root), 'blocks/projects/xingular-agent/brief.md'))).toBe(true)
  const enablement = readJson<Record<string, string[]>>(join(root, 'config/registry-enabled.json'))!
  expect(enablement.global[0]).toBe('skills/a')
  expect('personal' in enablement).toBe(false)
})

test('a failed migration leaves the wiki untouched', () => {
  const root = v2Layout()
  // An unreadable project registry makes staging fail.
  writeFileSync(join(root, 'projects.json'), 'not json')
  expect(() => run(createEnv(root))).toThrow()
  expect(isFile(join(root, 'wiki/docs/observed.md'))).toBe(true)
  expect(isDir(join(root, 'wiki.migrating')) || isDir(join(root, 'wiki.pre-v3'))).toBe(false)
  expect(version(root)).toBe(2)
})

test('fresh data roots need no migration', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-migrate-'))
  mkdirSync(root, { recursive: true })
  expect(version(root)).toBe(WIKI_VERSION)
  expect(run(createEnv(root))).toBe(false)
})
