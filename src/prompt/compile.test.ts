import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { dataRoot } from '../../tests/helpers'
import type { CallerContext } from '../core/caller'
import { createEnv, type HarnessEnv } from '../core/env'
import { writeJson } from '../core/fs'
import { closeIndex } from '../core/index'
import { materialise } from '../variant/materialise'
import * as store from '../variant/store'
import type { Variant } from '../variant/surface'
import * as notes from '../wiki/notes'
import { compile, fit, load, render, REPORTING_GUIDANCE, sessionFile, sessionLaunch, SECTION_ORDER, type ContextUpdate, type HostSection, type Launch } from './compile'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(closeIndex))

function setup(): HarnessEnv {
  const root = dataRoot()
  roots.push(root)
  writeJson(join(root, 'projects.json'), [{ id: 'p1', name: 'Xingular Agent', rootPath: '/src/xingular-agent', autoMaintenance: true, createdAt: 't', slug: 'xingular-agent' }])
  notes.ensureLayout(root, 'Test')
  notes.write(root, 'projects/xingular-agent/decisions', '---\ntitle: Decisions\n---\n\nTauri 2 for the shell. See [[library/glossary]].\n')
  notes.write(root, 'library/glossary', '# Glossary\n\nA harness is the system around a model.\n')
  mkdirSync(join(root, 'runs/run-1'), { recursive: true })
  return createEnv(root)
}

const variant: Variant = {
  'systemprompt.md': 'You draft release notes.\n',
  'guardrails.md': 'Never publish without a review.\n- When writing a changelog, load the `changelog` skill.\n',
  'memory.md': 'Releases ship on Tuesdays.\n',
  'tool_guidance.md': 'Prefer grep over reading whole files.\n',
  'skills/changelog/SKILL.md': '---\nname: changelog\ndescription: writing a changelog\n---\nGroup by type.\n',
  'sub_agents/reader/AGENT.md': '---\ndescription: reads long logs and answers briefly\n---\nRead the log and answer in three lines.\n',
  'scripts/count.py': 'print(1)\n'
}

const agent = (extra: Partial<CallerContext> = {}): CallerContext => ({ agentId: 'nora', agentName: 'Nora', projectId: 'p1', runId: 'run-1', actor: 'Chat', ...extra })
const identity: HostSection = { id: 'identity', title: 'Identity', body: 'You are Nora.', budget: 1000, order: 10 }
const work = (body: string): HostSection => ({ id: 'work', title: 'Active work', body, budget: 1000, order: 70, dynamic: true })
const hosted = (extra: Partial<Launch> = {}): Launch => ({ sections: [identity, work('You have no unresolved work.')], tools: ['read'], ...extra })

function scoped(env: HarnessEnv) {
  store.seed(env.root, 'nora', variant)
  return materialise(env.root, { scope: 'nora' }, { subagents: true })
}

test('cuts at a paragraph and points to the rest', () => {
  expect(fit('short', 100, '(more)')).toEqual({ body: 'short', cut: false })
  const cut = fit(`${'a'.repeat(40)}\n\n${'b'.repeat(40)}\n\n${'c'.repeat(40)}`, 100, '(more)')
  expect(cut.cut).toBe(true)
  expect(cut.body).toBe(`${'a'.repeat(40)}\n\n${'b'.repeat(40)}\n\n(more)`)
})

test('the variant supplies the instructions, guardrails, memory, subagents, scripts and tool guidance, in order', () => {
  const env = setup()
  const pack = compile(env, agent(), hosted(), scoped(env))
  const ids = pack.sections.map((entry) => entry.id)
  expect(ids).toEqual(['identity', 'system', 'guardrails', 'memory', 'subagents', 'scripts', 'work', 'wiki', 'tools', 'reporting'])
  const text = render(env, pack)
  expect(text).toContain('You draft release notes.')
  expect(text).toContain('Never publish without a review.')
  expect(text).toContain('Releases ship on Tuesdays.')
  expect(text).toContain('- reader — reads long logs and answers briefly')
  expect(text).toMatch(/scripts: count\.py/)
  expect(text).toContain('### How to use your tools\n\nPrefer grep over reading whole files.')
  expect(pack.variant).toEqual({ scope: 'nora', fingerprint: store.head(env.root, 'nora')!.fingerprint })
  expect(pack.sections.find((entry) => entry.id === 'system')!.sources).toEqual([{ id: 'nora', kind: 'variant', revision: pack.variant!.fingerprint }])
})

test('without a variant, only the application, the Wiki and the tools speak', () => {
  const env = setup()
  const pack = compile(env, agent(), hosted())
  expect(pack.sections.map((entry) => entry.id)).toEqual(['identity', 'work', 'wiki', 'tools', 'reporting'])
  expect(pack.variant).toBeNull()
})

test('the Wiki section lists the current project\'s notes and only describes wiki_write when it is on', () => {
  const env = setup()
  const text = render(env, compile(env, agent(), hosted()))
  expect(text).toContain('- projects/xingular-agent/decisions — Decisions')
  expect(text).toContain('wiki_search, wiki_read and wiki_list read project notes.')
  expect(text).not.toContain('wiki_write')
  expect(render(env, compile(env, agent(), hosted({ tools: ['read', 'wiki_write'] })))).toContain('wiki_write saves one')
})

test('the Wiki section points at lessons from earlier runs only when there are some', () => {
  const env = setup()
  expect(render(env, compile(env, agent(), hosted()))).not.toContain('library/lessons')
  notes.write(env.root, 'library/lessons/check-the-lockfile', '# Check the lockfile\n')
  expect(render(env, compile(env, agent(), hosted()))).toContain('1 of them is a lesson from earlier runs, under library/lessons')
})

test('selected notes are references for this request only', () => {
  const env = setup()
  const launch = hosted({ references: [{ kind: 'note', path: 'library/glossary' }, { kind: 'line', id: 'l1', label: 'Line', text: 'The user pinned a screenshot.' }] })
  const section = compile(env, agent(), launch).sections.find((entry) => entry.id === 'references')!
  expect(section.body).toContain('The user pinned a screenshot.')
  expect(section.body).toContain('A harness is the system around a model.')
  expect(section.sources[0]).toMatchObject({ id: 'library/glossary', kind: 'note' })
  expect(SECTION_ORDER.references).toBeLessThan(SECTION_ORDER.wiki)
})

function delivered(path: string, update: ContextUpdate): void {
  writeFileSync(path, `${JSON.stringify({ type: 'session', id: 'native-chat' })}\n${JSON.stringify({ type: 'custom_message', id: 'context-1', parentId: null, customType: 'xingular-context', content: update.content, details: { xingularContext: update.snapshot } })}\n`)
}

test('state stays out of the system prompt and only delivered changes are resent', () => {
  const env = setup()
  const materialised = scoped(env)
  const first = sessionLaunch(env, agent(), hosted(), null, materialised)
  expect(first.system).toContain('You draft release notes.')
  expect(first.system).not.toContain('You have no unresolved work.')
  expect(first.update!.content).toContain('You have no unresolved work.')
  expect(first.update!.content).toContain('## Wiki')
  const history = join(mkdtempSync(join(tmpdir(), 'harness-history-')), 'chat.jsonl')
  delivered(history, first.update!)
  const unchanged = sessionLaunch(env, agent(), hosted(), history, materialised)
  expect(unchanged.system).toBe(first.system)
  expect(unchanged.update).toBeNull()
  notes.write(env.root, 'projects/xingular-agent/release', '# Release checklist\n')
  const changed = sessionLaunch(env, agent(), hosted(), history, materialised)
  expect(changed.system).toBe(first.system)
  expect(changed.update!.content).toContain('projects/xingular-agent/release')
  expect(changed.update!.content).not.toContain('## Active work')
  expect(load(env.root, 'run-1')!.delivery!.updatedSectionIds).toEqual(['wiki'])
  // A new harness version changes the stable prefix, never the delivered state.
  store.commit(env.root, 'nora', { ...variant, 'memory.md': 'Releases ship on Thursdays.\n' }, { kind: 'edit' })
  const next = sessionLaunch(env, agent(), hosted(), history, materialise(env.root, { scope: 'nora' }, { subagents: true }))
  expect(next.system).toContain('Releases ship on Thursdays.')
  expect(next.system).not.toBe(first.system)
})

test('the snapshot follows the active branch and refreshes after compaction', () => {
  const env = setup()
  const initial = sessionLaunch(env, agent(), hosted(), null).update!
  const directory = mkdtempSync(join(tmpdir(), 'harness-history-'))
  const history = join(directory, 'chat.jsonl')
  delivered(history, initial)
  const original = readFileSync(history, 'utf8')
  writeFileSync(history, `${original}${JSON.stringify({ type: 'custom_message', id: 'other', parentId: null, customType: 'xingular-context', details: { xingularContext: [] } })}\n${JSON.stringify({ type: 'message', id: 'leaf', parentId: 'context-1' })}\n`)
  expect(sessionLaunch(env, agent(), hosted(), history).update).toBeNull()
  writeFileSync(history, `${original}${JSON.stringify({ type: 'compaction', id: 'summary', parentId: 'context-1' })}\n`)
  expect(sessionLaunch(env, agent(), hosted(), history).update!.content).toContain('## Wiki')
  expect(sessionFile(directory, join(directory, 'older.jsonl'))).toBe(join(directory, 'older.jsonl'))
  expect(sessionFile(directory)).toBe(history)
})

test('a subagent section is left out when the session cannot start subagents', () => {
  const env = setup()
  store.seed(env.root, 'nora', variant)
  const pack = compile(env, agent(), hosted(), materialise(env.root, { scope: 'nora' }, { subagents: false }))
  expect(pack.sections.some((entry) => entry.id === 'subagents')).toBe(false)
})

test('the reporting guidance closes the stable prefix and never rides in a context update', () => {
  const env = setup()
  const first = sessionLaunch(env, agent(), hosted(), null)
  expect(first.system).toContain(`## Reporting your work\n\n${REPORTING_GUIDANCE.trim()}`)
  expect(first.system.indexOf('## Reporting your work')).toBeGreaterThan(first.system.indexOf('## Tools'))
  expect(first.update!.content).not.toContain('Reporting your work')
  expect(first.pack.delivery!.systemSectionIds.at(-1)).toBe('reporting')
  expect(REPORTING_GUIDANCE).toContain('do not force a fixed set of report headings')
  expect(REPORTING_GUIDANCE).toContain('**Need human inspection** only when a concrete verification requires a person')
  expect(REPORTING_GUIDANCE).not.toContain('Worth a look')
  expect(REPORTING_GUIDANCE).not.toContain('Check by hand')
  const section = first.pack.sections.find((entry) => entry.id === 'reporting')!
  expect(section.cut).toBe(false)
  expect(sessionLaunch(env, agent(), hosted(), null).system).toBe(first.system)
})


test('describes naming only when available, including for CLI callers', () => {
  const env = setup()
  for (const surface of [undefined, 'cli']) {
    const caller = agent({ surface })
    const disabled = compile(env, caller, hosted())
    expect(disabled.toolGroups.some(group => group.tools.includes('session_name'))).toBe(false)
    const enabled = compile(env, caller, hosted({ tools: ['read', 'session_name'] }))
    expect(enabled.toolGroups).toContainEqual({ group: 'Session', tools: ['session_name'] })
    expect(render(env, enabled)).toContain('at most six words')
  }
})
