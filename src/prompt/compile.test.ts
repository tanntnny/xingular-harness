import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { dataRoot, writeFile } from '../../tests/helpers'
import { createEnv, type HarnessEnv } from '../core/env'
import { writeJson } from '../core/fs'
import { closeIndex } from '../core/index'
import * as blocks from '../memory/blocks'
import type { CallerContext } from '../memory/caller'
import * as references from '../memory/references'
import { readRunContext } from '../memory/runContext'
import { ensureProjectNamespace, wikiDir } from '../memory/store'
import { reindexWiki } from '../memory/wikiIndex'
import { compile, fit, launchText, load, memoryDelta, profileFor, profiles, record, REFERENCES_BUDGET, render, saveForSession, sessionFile, sessionLaunch, setProfile, type ContextPack, type ContextUpdate, type HostSection, type Launch } from './compile'

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
  const wiki = wikiDir(root)
  writeFileSync(join(wiki, 'projects/xingular-agent/decisions.md'), '---\nid: decisions\ntitle: Decisions\ntype: decision\n---\n\nTauri 2 for the shell.\n')
  writeFileSync(join(wiki, 'facts/pnpm.md'), '---\nid: pnpm\ntitle: Use pnpm\nkind: preference\nnamespace: /\nconfidence: high\n---\n\nUse pnpm, not npm.\n')
  writeFileSync(join(wiki, 'facts/on-call.md'), '---\nid: on-call\ntitle: On call this week\nkind: fact\nnamespace: /\nconfidence: high\nvolatile: true\n---\n\nAstro team is on call.\n')
  writeFileSync(join(wiki, 'facts/site-only.md'), '---\nid: site-only\ntitle: Site uses Astro\nkind: fact\nnamespace: /projects/site\n---\n\nAstro renders the site.\n')
  writeFile(join(root, 'registry/rules/tests.md'), '---\nname: Run tests\n---\n\nAlways run the tests.\n')
  writeFile(join(root, 'registry/skills/review/SKILL.md'), '---\nname: review\ndescription: Review a change\n---\n\nRead the diff first.\n')
  writeJson(join(root, 'config/registry-enabled.json'), { global: ['rules/tests'], p1: ['skills/review'] })
  mkdirSync(join(root, 'runs/run-1'), { recursive: true })
  reindexWiki(root)
  return createEnv(root)
}

const session = (project: string): CallerContext => ({ runId: 'run-1', sessionId: 's1', projectId: project, actor: 'Code' })
const agent = (extra: Partial<CallerContext> = {}): CallerContext => ({ agentId: 'nora', agentName: 'Nora', actor: 'Chat', ...extra })
const ids = (pack: ContextPack): string[] => pack.sections.map((entry) => entry.id)

// What an application supplies: who the model is, its role, and what it is working on.
const identity: HostSection = { id: 'identity', title: 'Identity', body: 'You are "Nora", an Xingular Agent agent.', budget: 6000, order: 10 }
const role: HostSection = { id: 'role', title: 'Role', body: 'You coordinate.', budget: 1500, order: 20 }
const work = (body: string | null, pinned?: string): HostSection => ({ id: 'work', title: 'Active work', body, budget: 1500, pointer: '(Call list_work for the full inventory.)', order: 70, dynamic: true, pinned: pinned ? { text: pinned, pointer: '(Call list_work for the full evidence.)' } : null })
const hosted = (extra: Partial<Launch> = {}): Launch => ({ sections: [identity, role, work('You have no unresolved work.\n')], ...extra })

test('cuts at a paragraph and points to the rest', () => {
  expect(fit('short', 100, '(more)')).toEqual({ body: 'short', cut: false })
  const cut = fit(`${'a'.repeat(40)}\n\n${'b'.repeat(40)}\n\n${'c'.repeat(40)}`, 100, '(more)')
  expect(cut.cut).toBe(true)
  expect(cut.body).toBe(`${'a'.repeat(40)}\n\n${'b'.repeat(40)}\n\n(more)`)
})

test('selected content is pinned and retained with automatic context off', () => {
  const env = setup()
  setProfile(env.root, 'nora', 'off')
  const revision = references.pin(env.root, 'skill', 'skills/review')
  writeFileSync(join(env.root, 'registry/skills/review/SKILL.md'), 'Changed instructions.')
  const newer = references.pin(env.root, 'skill', 'skills/review')
  const caller = agent({ runId: 'run-1' })
  const pack = compile(env, caller, hosted({ references: [{ kind: 'skill', id: 'skills/review', label: 'Review', revision }] }))
  expect(ids(pack)).toEqual(['identity', 'role', 'references'])
  const selected = pack.sections.find((entry) => entry.id === 'references')!
  expect(selected.body).toContain('Read the diff first.')
  expect(selected.body).not.toContain('Changed instructions.')
  expect(revision).not.toBe(newer)
  record(env.root, caller, pack)
  expect(references.readPinned(env.root, 'run-1', 'skills/review', revision, 0)).toContain('Read the diff first.')
  expect(() => references.readPinned(env.root, 'run-1', 'skills/review', newer, 0)).toThrow()
  expect(readRunContext(env.root, 'run-1')[0].revisionId).toBe(revision)
})

test('application lines sit with the references and large sources keep retrieval pointers', () => {
  const env = setup()
  writeFileSync(join(env.root, 'registry/skills/review/SKILL.md'), 'Review instructions.\n\n'.repeat(2000))
  const revision = references.pin(env.root, 'skill', 'skills/review')
  const pack = compile(env, agent(), { references: [{ kind: 'skill', id: 'skills/review', label: 'Review', revision }, { kind: 'line', id: 'exact-agent-id', label: 'Duplicate name', text: '- Agent "Duplicate name": exact ID "exact-agent-id". Agent messaging is unavailable in this reply.' }] })
  const selected = pack.sections.find((entry) => entry.id === 'references')!
  expect(selected.body).toContain('Agent messaging is unavailable')
  expect(selected.cut).toBe(true)
  expect(selected.size).toBeLessThanOrEqual(REFERENCES_BUDGET)
  expect(selected.body).toContain('wiki_read(id="skills/review", revision=')
  expect(selected.sources[0].revision).toBe(revision)
})

test('a session gets blocks, rules, skills, knowledge and tools', () => {
  const env = setup()
  const pack = compile(env, session('p1'), { connections: 'Use get_capabilities.' })
  expect(pack.profile).toBe('session')
  expect(ids(pack)).toEqual(['blocks', 'rules', 'skills', 'knowledge', 'tools'])
  const text = render(env, pack)
  for (const expected of ['<block label="user"', '<block label="project/xingular-agent"', 'Always run the tests.', 'review (skills/review)', '/projects/xingular-agent/decisions — Decisions', 'Use pnpm', 'App tools and connected apps: Use get_capabilities.']) expect(text).toContain(expected)
  expect(text).not.toContain('Astro')
  const cli = render(env, compile(env, { ...session('p1'), surface: 'cli' }))
  expect(cli).toContain('xagent-wiki search')
  expect(cli).toContain('xagent-wiki block append')
})

test('long rules shorten only the rules section', () => {
  const env = setup()
  writeFileSync(join(env.root, 'registry/rules/tests.md'), `---\nname: Run tests\n---\n\n${'Always run the tests.\n\n'.repeat(600)}\n`)
  const pack = compile(env, session('p1'))
  const rules = pack.sections.find((entry) => entry.id === 'rules')!
  expect(rules.cut && rules.size <= 3000 && rules.body.endsWith('wiki_list kind rule.)')).toBe(true)
  expect(ids(pack)).toEqual(['blocks', 'rules', 'skills', 'knowledge', 'tools'])
  expect(pack.sections.filter((entry) => entry.id !== 'rules').every((entry) => !entry.cut)).toBe(true)
})

test('an agent gets the application sections, its blocks and the tool groups in order', () => {
  const env = setup()
  const pack = compile(env, agent({ runId: 'run-1' }), hosted({
    input: 'How does Astro render the site?',
    tools: ['dispatch_work', 'list_agents', 'read'],
    toolGroups: [
      { group: 'Work', tools: ['dispatch_work'], guidance: 'Work (dispatch_work): record and dispatch substantial tasks.', order: 30 },
      { group: 'Agents', tools: ['list_agents', 'get_agent'], guidance: 'Agents (list_agents, get_agent): see and message the other agents.', order: 40 },
      { group: 'Browser', tools: [], guidance: 'Browser: act in the managed browser.', order: 50 },
      { group: 'Files', tools: ['files_list', 'files_read'], guidance: 'Saved files (files_list, files_read): read the shared vault.', order: 80 }
    ]
  }))
  expect(pack.toolGroups.map((group) => group.group)).toEqual(['Memory', 'Knowledge', 'Work', 'Agents', 'Native', 'Files'])
  expect(pack.toolGroups[3].tools).toEqual(['list_agents', 'get_agent'])
  const tools = pack.sections.at(-1)!.body
  expect(tools).toContain('Work (dispatch_work)')
  expect(tools).toContain('Files (read)')
  expect(tools).not.toContain('Browser')
  expect(tools).not.toContain('connected apps')
  expect(pack.profile).toBe('agent')
  expect(ids(pack)).toEqual(['identity', 'role', 'blocks', 'rules', 'skills', 'work', 'knowledge', 'tools'])
  const text = render(env, pack)
  for (const expected of ['# Xingular Harness context\n\nYou are "Nora", an Xingular Agent agent.\n\n## Role', '<block label="persona"', '<block label="notes"', 'You have no unresolved work.', '- /projects/xingular-agent', 'Site uses Astro']) expect(text).toContain(expected)
  // A volatile fact is never carried, even when it matches.
  expect(text).not.toContain('On call this week')
  // A skill enabled for one project is not listed for an agent, only pointed to.
  expect(text).not.toContain('review (skills/review)')
})

test('a running session is told once when a block changes', () => {
  const env = setup()
  const directory = mkdtempSync(join(tmpdir(), 'harness-session-'))
  saveForSession(directory, compile(env, session('p1')))
  expect(memoryDelta(env, directory, session('p1'))).toBeNull()
  blocks.edit(env.root, { kind: 'user' }, 'project/xingular-agent', { kind: 'append', text: 'Uses pnpm.' })
  const note = memoryDelta(env, directory, session('p1'))!
  expect(note.startsWith('[Memory updated since')).toBe(true)
  expect(note).toContain('<block label="project/xingular-agent"')
  expect(note).toContain('Uses pnpm.')
  expect(note).not.toContain('<block label="user"')
  expect(memoryDelta(env, directory, session('p1'))).toBeNull()
})

test('a profile limits the sections and is recorded', () => {
  const env = setup()
  expect(profileFor(env.root, session('p1'))).toBe('full')
  setProfile(env.root, 's1', 'minimal')
  const pack = compile(env, session('p1'))
  expect([pack.contextProfile, ids(pack)]).toEqual(['minimal', ['rules', 'tools']])
  setProfile(env.root, 's1', 'off')
  const off = compile(env, session('p1'))
  expect([off.sections, off.toolGroups]).toEqual([[], []])
  setProfile(env.root, 's1', 'full')
  expect(profiles(env.root)).toEqual({})
  expect(() => setProfile(env.root, '../x', 'off')).toThrow()
})

test('the pack is recorded with the run', () => {
  const env = setup()
  const text = launchText(env, session('p1'))
  const saved = load(env.root, 'run-1')!
  expect(render(env, saved)).toBe(text)
  expect(saved.sections.some((entry) => entry.id === 'blocks' && entry.sources.some((source) => source.id === 'blocks/shared/user'))).toBe(true)
  expect(readRunContext(env.root, 'run-1').some((entry) => entry.id === 'rules/tests' && entry.via === 'entrypoint')).toBe(true)
  expect(load(env.root, 'missing')).toBeNull()
})

function delivered(path: string, update: ContextUpdate): void {
  writeFileSync(path, `${JSON.stringify({ type: 'session', id: 'native-chat' })}\n${JSON.stringify({ type: 'custom_message', id: 'context-1', parentId: null, customType: 'xingular-context', content: update.content, details: { xingularContext: update.snapshot } })}\n`)
}

test('state stays out of the system prompt and only delivered changes are resent', () => {
  const env = setup()
  const caller = agent({ runId: 'run-1' })
  const first = sessionLaunch(env, caller, hosted(), null)
  const initial = first.update!
  expect(first.system).not.toContain('<block')
  expect(first.system).not.toContain('You have no unresolved work.')
  expect(first.system.endsWith('through tools when needed.\n')).toBe(true)
  expect(initial.content).toContain('<block')
  expect(initial.content).toContain('You have no unresolved work.')
  // Recording a prepared launch is not evidence that the session received its context.
  expect(sessionLaunch(env, caller, hosted(), null).update).not.toBeNull()
  const history = join(mkdtempSync(join(tmpdir(), 'harness-history-')), 'chat.jsonl')
  delivered(history, initial)
  const unchanged = sessionLaunch(env, caller, hosted(), history)
  expect(unchanged.system).toBe(first.system)
  expect(unchanged.update).toBeNull()
  blocks.edit(env.root, { kind: 'user' }, 'user', { kind: 'append', text: 'New shared preference.' })
  const changed = sessionLaunch(env, caller, hosted(), history)
  expect(changed.system).toBe(first.system)
  expect(changed.update!.content).toContain('New shared preference.')
  expect(changed.update!.content).not.toContain('## Active work')
  expect(changed.update!.content).not.toContain('## Knowledge')
  expect(load(env.root, 'run-1')!.delivery!.updatedSectionIds).toEqual(['blocks'])
  writeFileSync(join(env.root, 'registry/rules/tests.md'), '---\nname: Run tests\n---\n\nFollow the updated rule.\n')
  const updated = sessionLaunch(env, caller, hosted(), history).system
  expect(updated).not.toBe(first.system)
  expect(updated).toContain('Follow the updated rule.')
})

test('pinned application text reaches native history with context off without changing the system prefix', () => {
  const env = setup()
  setProfile(env.root, 'nora', 'off')
  const before = sessionLaunch(env, agent(), hosted(), null)
  const after = sessionLaunch(env, agent(), { sections: [identity, role, work('You have no unresolved work.\n', 'Recent task reports:\n\nTask t1: Reviewed evidence shown to the user\n')] }, null)
  expect(after.system).toBe(before.system)
  expect(after.update!.content).toContain('Reviewed evidence shown to the user')
  expect(after.update!.content).not.toContain('You have no unresolved work.')
  expect(before.update!.content).not.toContain('Reviewed evidence')
})

test('references apply to each request and profile changes withdraw old state', () => {
  const env = setup()
  const revision = references.pin(env.root, 'skill', 'skills/review')
  const launch = hosted({ references: [{ kind: 'skill', id: 'skills/review', label: 'Review', revision }] })
  const first = sessionLaunch(env, agent(), launch, null)
  expect(first.system).not.toContain('Read the diff first.')
  const history = join(mkdtempSync(join(tmpdir(), 'harness-history-')), 'chat.jsonl')
  delivered(history, first.update!)
  const repeated = sessionLaunch(env, agent(), launch, history).update!
  expect(repeated.content).toContain('Read the diff first.')
  expect(repeated.content).not.toContain('## Memory blocks')
  const removed = sessionLaunch(env, agent(), hosted(), history).update!
  expect(removed.content).toContain('## references')
  expect(removed.content).not.toContain('Read the diff first.')
  setProfile(env.root, 'nora', 'off')
  const withdrawn = sessionLaunch(env, agent(), hosted(), history).update!
  expect(withdrawn.snapshot).toEqual([])
  for (const id of ['blocks', 'references', 'work', 'knowledge']) expect(withdrawn.content).toContain(`## ${id}`)
  expect(sessionLaunch(env, agent(), launch, history).update!.content).toContain('Read the diff first.')
})

test('the snapshot follows the active branch and refreshes after compaction', () => {
  const env = setup()
  const initial = sessionLaunch(env, agent(), hosted(), null).update!
  const directory = mkdtempSync(join(tmpdir(), 'harness-history-'))
  const history = join(directory, 'chat.jsonl')
  delivered(history, initial)
  const original = readFileSync(history, 'utf8')
  // An unrelated branch's snapshot must not decide what this branch already received.
  writeFileSync(history, `${original}${JSON.stringify({ type: 'custom_message', id: 'other', parentId: null, customType: 'xingular-context', details: { xingularContext: [] } })}\n${JSON.stringify({ type: 'message', id: 'leaf', parentId: 'context-1' })}\n`)
  expect(sessionLaunch(env, agent(), hosted(), history).update).toBeNull()
  writeFileSync(history, `${original}${JSON.stringify({ type: 'compaction', id: 'summary', parentId: 'context-1' })}\n`)
  expect(sessionLaunch(env, agent(), hosted(), history).update!.content).toContain('## Memory blocks')
  expect(sessionFile(directory, join(directory, 'older.jsonl'))).toBe(join(directory, 'older.jsonl'))
  expect(sessionFile(directory)).toBe(history)
})
