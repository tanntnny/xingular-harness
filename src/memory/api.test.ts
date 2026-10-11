import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { dataRoot, writeFile } from '../../tests/helpers'
import { createEnv, type HarnessEnv } from '../core/env'
import { writeJson } from '../core/fs'
import { closeIndex } from '../core/index'
import { launchText } from '../prompt/compile'
import { list, memories, memoryEdit, propose, read, search, skill } from './api'
import * as blocks from './blocks'
import type { CallerContext } from './caller'
import { findMemory } from './facts'
import { readRunContext } from './runContext'
import { ensureProjectNamespace, wikiDir } from './store'
import { reindexWiki } from './wikiIndex'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(closeIndex))

function setup(): HarnessEnv {
  const root = dataRoot()
  roots.push(root)
  writeJson(join(root, 'projects.json'), [
    { id: 'p1', name: 'Xingular Agent', rootPath: '/src/xingular-agent', autoMaintenance: true, createdAt: 't', slug: 'xingular-agent' },
    { id: 'p2', name: 'Site', rootPath: '/src/site', autoMaintenance: true, createdAt: 't', slug: 'site' }
  ])
  ensureProjectNamespace(root, 'xingular-agent', 'Xingular Agent')
  ensureProjectNamespace(root, 'site', 'Site')
  const wiki = wikiDir(root)
  writeFileSync(join(wiki, 'projects/site/deploy.md'), '---\nid: deploy\ntitle: Deploying the site\ntype: decision\nsourceIds: [run:r0]\n---\n\nThe site deploys with wrangler.\n')
  writeFileSync(join(wiki, 'facts/pnpm.md'), '---\nid: pnpm\ntitle: Use pnpm\nkind: preference\nnamespace: /\nconfidence: high\n---\n\nUse pnpm, not npm.\n')
  writeFileSync(join(wiki, 'facts/site-only.md'), '---\nid: site-only\ntitle: Site uses Astro\nkind: fact\nnamespace: /projects/site\n---\n\nAstro.\n')
  writeFile(join(root, 'registry/rules/tests.md'), '---\nname: Run tests\n---\n\nAlways run the tests.\n')
  writeFile(join(root, 'registry/skills/review/SKILL.md'), '---\nname: review\ndescription: Review a change\n---\n\nRead the diff first.\n')
  writeJson(join(root, 'config/registry-enabled.json'), { global: ['rules/tests'], p1: ['skills/review'] })
  mkdirSync(join(root, 'runs/run-1'), { recursive: true })
  writeJson(join(root, 'runs/run-1/run.json'), { id: 'run-1', projectId: 'p1', mode: 'code', harness: 'pi', sessionType: 'structured', sessionId: 's1', nativeSessionId: null, workingDirectory: null, worktreeId: null, goal: 'Please keep commits small from now on.', startedAt: 't', endedAt: null, status: 'running' })
  reindexWiki(root)
  return createEnv(root)
}

const context = (project: string): CallerContext => ({ runId: 'run-1', projectId: project, actor: 'Code' })

test('sessions edit their project brief through memory calls', () => {
  const env = setup()
  expect(memoryEdit(env, context('p1'), 'memory.append', { block: 'project', text: 'Tauri 2 desktop app.' })).toContain('project/xingular-agent')
  expect(launchText(env, context('p1'))).toContain('Tauri 2 desktop app.')
  expect(() => memoryEdit(env, context('p1'), 'memory.append', { block: 'user', text: 'x' })).toThrow()
  // A session reads its project's brief by id, but never an agent's blocks.
  expect(read(env, context('p1'), { id: 'blocks/projects/xingular-agent/brief' })).toContain('Tauri 2 desktop app.')
  blocks.ensureAgent(wikiDir(env.root), 'a1')
  expect(() => read(env, context('p1'), { id: 'blocks/agents/a1/persona' })).toThrow()
  expect(() => memoryEdit(env, { actor: 'Chat' }, 'memory.append', { block: 'user', text: 'x' })).toThrow()
  expect(readRunContext(env.root, 'run-1').some((entry) => entry.id === 'blocks/projects/xingular-agent/brief' && entry.via === 'edit')).toBe(true)
})

test('agents read across project namespaces', () => {
  const env = setup()
  const hits = search(env, context('p1'), { query: 'wrangler' })
  expect(hits).toContain('Deploying the site')
  expect(hits).toContain('/projects/site/deploy')
  const page = read(env, context('p1'), { id: '/projects/site/deploy' })
  expect(page).toContain('The site deploys with wrangler.')
  expect(page).toContain('Sources: run:r0')
  expect(skill(env, context('p2'), { name: 'review' })).toContain('Read the diff first.')
  expect(memories(env, context('p1'), { namespace: '/projects/site' })).toContain('Astro')
  expect(list(env, {})).toContain('/projects/site')
  expect(readRunContext(env.root, 'run-1').some((entry) => entry.id === 'deploy' && entry.via === 'read')).toBe(true)
})

test('proposals apply in the project namespace or wait in the inbox', () => {
  const env = setup()
  const applied = propose(env, context('p1'), { kind: 'memory', title: 'Small commits', type: 'preference', body: 'Keep commits small.', confidence: 'high', sourceRefs: [{ kind: 'run', ref: 'current', excerpt: 'please keep commits small' }] })
  expect(applied).toContain('saved')
  expect(findMemory(wikiDir(env.root), 'small-commits').front.namespace).toBe('/projects/xingular-agent')
  expect(propose(env, context('p1'), { kind: 'page', title: 'Rumor', body: 'Maybe.' })).toContain('Inbox')
  // The caller's own run without a quote from it is not evidence.
  expect(propose(env, context('p1'), { kind: 'memory', title: 'Bare', body: 'Unquoted.', confidence: 'high', sourceRefs: [{ kind: 'run', ref: 'current' }] })).toContain('Inbox')
  expect(propose(env, context('p1'), { kind: 'skill', title: 'Deploy', body: 'Steps.' })).toContain('waiting in the Wiki Inbox')
  expect(existsSync(join(env.root, 'registry/skills/deploy'))).toBe(false)
})
