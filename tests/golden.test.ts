// Byte parity with the Rust host this harness was ported from. `tests/golden/root` is a data
// root that host built, and `expected.json` is what it compiled and answered for it, in order.
// Every string must match, apart from ids and paths that are new on each run.
import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, test } from 'vitest'

import { createEnv } from '../src/core/env'
import { closeIndex } from '../src/core/index'
import * as api from '../src/memory/api'
import * as blocks from '../src/memory/blocks'
import type { CallerContext } from '../src/memory/caller'
import * as recall from '../src/memory/recall'
import { reindexWiki } from '../src/memory/wikiIndex'
import { compile, render, sessionLaunch, setProfile, type HostSection, type HostToolGroup, type Launch, type Reference, type Section, type ToolGroup } from '../src/prompt/compile'

interface ExpectedPack {
  text: string
  sections: Section[]
  toolGroups: ToolGroup[]
  profile: string
  contextProfile: string
}
export interface ExpectedLaunch {
  system: string
  update: { content: string; snapshot: Section[] } | null
}
type Reply = { ok: string } | { error: string }
interface Golden {
  root: string
  agentId: string
  agentName: string
  briefProjectIds: string[]
  references: { kind: 'skill' | 'wiki' | 'agent'; id: string; label: string; revision: string | null }[]
  cases: { name: string; value: unknown }[]
}

const here = dirname(fileURLToPath(import.meta.url))
const golden = JSON.parse(readFileSync(join(here, 'golden/expected.json'), 'utf8')) as Golden
const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-golden-')))
cpSync(join(here, 'golden/root'), root, { recursive: true })
const env = createEnv(root, { productName: 'Xingular Agent', directory: { agentName: (id) => (id === golden.agentId ? golden.agentName : null), sessionAgent: () => null } })
afterAll(() => closeIndex(root))

const expected = new Map(golden.cases.map((entry) => [entry.name, entry.value]))
const seen: string[] = []

/** Ids and paths that differ between the two runs; everything else must be identical. */
function normalize(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replaceAll(golden.root, '<ROOT>')
      .replaceAll(root, '<ROOT>')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<ID>')
      .replace(/@[0-9a-f]{8}\]/g, '@<REV>]')
      .replace(/operation [0-9a-f]{8};/g, 'operation <OP>;')
  }
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, normalize(entry)]))
  return value
}

// When text a model reads is meant to change, the fixture is rewritten on purpose:
// `UPDATE_GOLDEN=1 npx vitest run tests/golden.test.ts`. Only cases that differ are replaced, the
// change is reviewed as a diff of `expected.json`, and the commit says why.
const updating = process.env.UPDATE_GOLDEN === '1'
const updated: string[] = []

/** A value as it is recorded: this run's folder written as the recorded one, so later runs compare equal. */
function recorded(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(root, golden.root)
  if (Array.isArray(value)) return value.map(recorded)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, recorded(entry)]))
  return value
}

function check(name: string, actual: unknown): void {
  expect(expected.has(name), `no recorded case ${name}`).toBe(true)
  seen.push(name)
  if (updating) {
    if (JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(expected.get(name)))) {
      golden.cases.find((entry) => entry.name === name)!.value = recorded(JSON.parse(JSON.stringify(actual)))
      updated.push(name)
    }
    return
  }
  expect(normalize(actual), name).toEqual(normalize(expected.get(name)))
}

function reply(run: () => string): Reply {
  try {
    return { ok: run() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// ---- What the application supplied in the recorded run ------------------------------------------

const HOST_ORDER: Record<string, number> = { identity: 10, role: 20, work: 70 }
const GROUP_ORDER: Record<string, number> = { Work: 30, Agents: 40, Browser: 50, Files: 80 }
const GROUP_PREFIX: Record<string, string> = { Work: 'Work (', Agents: 'Agents (', Browser: 'Browser and computer (', Files: 'Saved files (' }

/** The sections and tool groups the application wrote for a recorded pack. */
function hosted(name: string, extra: Launch = {}): Launch {
  const pack = expected.get(name) as ExpectedPack
  const sections: HostSection[] = pack.sections
    .filter((entry) => entry.id in HOST_ORDER)
    .map((entry) => ({ id: entry.id, title: entry.title, body: entry.body, budget: entry.budget, order: HOST_ORDER[entry.id], dynamic: entry.id === 'work', pointer: entry.id === 'work' ? '(Call list_work for the full inventory.)' : '' }))
  // The work slot is declared for every agent turn, so a withdrawn section is announced.
  if (!sections.some((entry) => entry.id === 'work')) sections.push({ id: 'work', title: 'Active work', body: null, budget: 1500, order: HOST_ORDER.work, dynamic: true })
  const guidance = (pack.sections.find((entry) => entry.id === 'tools')?.body ?? '').split('\n\n')
  const toolGroups: HostToolGroup[] = pack.toolGroups
    .filter((group) => group.group in GROUP_ORDER)
    .map((group) => ({ group: group.group, tools: group.tools, order: GROUP_ORDER[group.group], guidance: guidance.find((paragraph) => paragraph.startsWith(GROUP_PREFIX[group.group])) ?? '' }))
  return { sections, toolGroups, connectionTools: ['get_capabilities', 'mcp_list_tools', 'mcp_call_tool'], toolsPointer: '(Call get_capabilities for the complete tool inventory.)', profile: pack.profile, ...extra }
}

function packCase(name: string, context: CallerContext, launch: Launch): void {
  const pack = compile(env, context, launch)
  check(name, { text: render(env, pack), sections: pack.sections, toolGroups: pack.toolGroups, profile: pack.profile, contextProfile: pack.contextProfile })
}

/** A selection as the application passes it: pinned pages and skills, and its own line for an agent. */
function selections(canMessage: boolean): Reference[] {
  return golden.references.map((reference) =>
    reference.kind === 'agent'
      ? {
          kind: 'line',
          id: reference.id,
          label: reference.label,
          text: `- Agent ${JSON.stringify(reference.label)}: exact ID ${JSON.stringify(reference.id)}. ${canMessage ? "Consult this agent with message_agent using its exact ID when the user's request calls for it. A mention alone does not require contact; pass the relevant question and context." : 'Agent messaging is unavailable in this reply. Do not claim to have contacted them or attempt to bypass permissions. In a group, existing member routing applies.'}`
        }
      : { kind: reference.kind === 'skill' ? 'skill' : 'page', id: reference.id, label: reference.label, revision: reference.revision! }
  )
}

test('reproduces what the Rust host compiled and answered', () => {
  reindexWiki(root)
  const code: CallerContext = { runId: 'run-now-code', sessionId: 's1', projectId: 'p1', actor: 'Code' }
  const loose: CallerContext = { sessionId: 's2', actor: 'Code' }
  const chat: CallerContext = { runId: 'run-now-chat', sessionId: golden.agentId, agentId: golden.agentId, agentName: golden.agentName, briefProjectIds: golden.briefProjectIds, actor: 'Chat' }
  const sessionTools = ['read', 'bash', 'browser_navigate']
  const agentTools = ['dispatch_work', 'list_work', 'list_agents', 'message_agent', 'read', 'grep', 'write', 'bash', 'browser_navigate', 'browser_read', 'computer_click']
  const reading = ['read', 'grep', 'find', 'ls']
  const input = 'How does Astro render the site, and how do we deploy it with wrangler?'
  const connections = 'Call get_capabilities to see connected apps, then mcp_list_tools and mcp_call_tool.'
  // A session's browser tools are the application's group; the recorded run had them switched on.
  const sessionGroups = (name: string): Launch => ({ toolGroups: hosted(name).toolGroups, connectionTools: ['get_capabilities', 'mcp_list_tools', 'mcp_call_tool'], toolsPointer: '(Call get_capabilities for the complete tool inventory.)', profile: 'operator' })
  // The recorded run named a session the user started `operator`.
  const pointer = { toolsPointer: '(Call get_capabilities for the complete tool inventory.)', profile: 'operator' }

  packCase('compile.session', code, pointer)
  packCase('compile.session.tools', code, { input, connections, tools: sessionTools, ...sessionGroups('compile.session.tools') })
  packCase('compile.session.cli', { ...code, surface: 'cli' }, pointer)
  packCase('compile.session.loose', loose, { input, ...pointer })
  packCase('compile.agent', chat, hosted('compile.agent', { input, tools: reading }))
  packCase('compile.agent.tools', chat, hosted('compile.agent.tools', { input, connections, tools: agentTools }))
  packCase('compile.agent.references', chat, hosted('compile.agent.references', { input, tools: agentTools, references: selections(true) }))
  packCase('compile.agent.references.reading', chat, hosted('compile.agent.references.reading', { input, tools: reading, references: selections(false) }))
  setProfile(root, golden.agentId, 'minimal')
  packCase('compile.agent.minimal', chat, hosted('compile.agent.minimal', { input, tools: agentTools, references: selections(true) }))
  setProfile(root, golden.agentId, 'off')
  packCase('compile.agent.off', chat, hosted('compile.agent.off', { input, tools: agentTools, references: selections(true) }))
  setProfile(root, golden.agentId, 'full')
  setProfile(root, 's1', 'minimal')
  packCase('compile.session.minimal', code, { input, connections, tools: sessionTools, ...sessionGroups('compile.session.minimal') })
  setProfile(root, 's1', 'full')

  const launch = hosted('compile.agent.tools', { input, connections, tools: agentTools })
  const initial = sessionLaunch(env, chat, launch, null)
  check('chat.initial', initial)
  const history = join(root, 'history.jsonl')
  writeFileSync(history, `${JSON.stringify({ type: 'session', id: 'native-chat' })}\n${JSON.stringify({ type: 'custom_message', id: 'context-1', parentId: null, customType: 'xingular-context', content: initial.update!.content, details: { xingularContext: initial.update!.snapshot } })}\n`)
  check('chat.unchanged', sessionLaunch(env, chat, launch, history))
  blocks.edit(root, { kind: 'user' }, 'user', { kind: 'append', text: 'Prefers concise answers.' })
  check('chat.changed', sessionLaunch(env, chat, launch, history))
  check('chat.references', sessionLaunch(env, chat, { ...launch, references: selections(true) }, history))

  for (const [label, caller] of [['code', code], ['chat', chat]] as const) {
    check(`search.${label}.wrangler`, { ok: api.search(env, caller, { query: 'wrangler deploy' }) })
    check(`search.${label}.kinds`, { ok: api.search(env, caller, { query: 'pnpm', kinds: ['memory', 'rule', 'block'], limit: 4 }) })
    check(`search.${label}.namespace`, { ok: api.search(env, caller, { query: 'tauri shell', namespace: '/library' }) })
    check(`search.${label}.blocks`, { ok: api.search(env, caller, { query: 'deploy checklist follow', kinds: ['block'] }) })
    check(`search.${label}.none`, { ok: api.search(env, caller, { query: 'zebra' }) })
    for (const key of ['xingular-agent-decisions', '/projects/xingular-agent/architecture/runtime', 'long-guide', 'pnpm', '/facts/old-shell', 'blocks/shared/user', 'blocks/projects/xingular-agent/brief', 'skills/review', 'rules/style', 'prompts/standup', 'missing-entry']) {
      check(`read.${label}.${key}`, reply(() => api.read(env, caller, { id: key })))
    }
    check(`read.${label}.agent-block`, reply(() => api.read(env, caller, { id: `blocks/agents/${golden.agentId}/notes` })))
    check(`skill.${label}.index`, { ok: api.skill(env, caller, {}) })
    check(`skill.${label}.review`, { ok: api.skill(env, caller, { name: 'Review' }) })
    check(`skill.${label}.file`, { ok: api.skill(env, caller, { name: 'release-notes' }) })
    check(`skill.${label}.missing`, { ok: api.skill(env, caller, { name: 'nope' }) })
    check(`memories.${label}.default`, { ok: api.memories(env, caller, {}) })
    check(`memories.${label}.query`, { ok: api.memories(env, caller, { query: 'astro wrangler' }) })
    check(`memories.${label}.namespace`, { ok: api.memories(env, caller, { namespace: '/projects/site' }) })
  }
  const listings: [string, Record<string, unknown>][] = [['default', {}], ['library', { namespace: '/library' }], ['project', { namespace: '/projects/xingular-agent' }], ['memory', { kind: 'memory' }], ['memory.site', { kind: 'memory', namespace: '/projects/site' }], ['skill', { kind: 'skill' }], ['rule', { kind: 'rule' }], ['prompt', { kind: 'prompt' }]]
  for (const [label, params] of listings) check(`list.${label}`, { ok: api.list(env, params) })
  check('read.chat.pinned', reply(() => api.read(env, chat, { id: 'long-guide', revision: golden.references[1].revision, offset: 0 })))

  recall.sync(root)
  const searches: [string, CallerContext, Record<string, unknown>][] = [
    ['chat.own', chat, { query: 'pnpm package manager' }],
    ['chat.all', chat, { query: 'pnpm', scope: 'all' }],
    ['chat.project', chat, { query: 'pnpm', project: 'site' }],
    ['chat.since', chat, { query: 'pnpm', since: '2027-01-01' }],
    ['chat.none', chat, { query: 'zebra' }],
    ['code.project', code, { query: 'pnpm lockfile', scope: 'all' }],
    ['code.loose', loose, { query: 'pnpm' }]
  ]
  for (const [label, caller, params] of searches) check(`recall.search.${label}`, reply(() => recall.searchTool(env, caller, params)))
  check('recall.read.chat', reply(() => recall.readTool(env, chat, { run: 'run-chat-2' })))
  check('recall.read.code', reply(() => recall.readTool(env, code, { runId: 'run-code-1' })))
  check('recall.read.denied', reply(() => recall.readTool(env, code, { run: 'run-chat-1' })))

  check('edit.code.project', reply(() => api.memoryEdit(env, code, 'memory.append', { block: 'project', text: 'Uses pnpm workspaces.' })))
  check('edit.code.user', reply(() => api.memoryEdit(env, code, 'memory.append', { block: 'user', text: 'x' })))
  check('edit.chat.replace', reply(() => api.memoryEdit(env, chat, 'memory.replace', { block: 'notes', old: 'deploy checklist', new: 'release checklist' })))
  check('edit.chat.readonly', reply(() => api.memoryEdit(env, chat, 'memory.append', { block: 'team-habits', text: 'x' })))
  check('edit.chat.rethink', reply(() => api.memoryEdit(env, chat, 'memory.rethink', { block: 'persona', body: 'Coordinates work and keeps answers short.' })))
  check('propose.code.memory', reply(() => api.propose(env, code, { kind: 'memory', title: 'Small commits', type: 'preference', body: 'Keep commits small.', confidence: 'high', sourceRefs: [{ kind: 'run', ref: 'current', excerpt: 'please keep commits small' }] })))
  check('propose.code.uncited', reply(() => api.propose(env, code, { kind: 'page', title: 'Rumor', body: 'Maybe.' })))
  check('propose.code.secret', reply(() => api.propose(env, code, { kind: 'memory', title: 'Token', body: 'key sk-ant-abc123', sourceRefs: [{ kind: 'url', ref: 'https://example.com' }] })))
  check('propose.code.page', reply(() => api.propose(env, code, { kind: 'page', title: 'Commit policy', type: 'decision', body: 'Commits stay small.', links: [{ toId: 'pnpm', type: 'references' }, { toId: 'unknown', type: 'references' }], sourceRefs: [{ kind: 'url', ref: 'https://example.com/policy' }] })))
  check('propose.chat.skill', reply(() => api.propose(env, chat, { kind: 'skill', title: 'Deploy', body: 'Steps.', reason: 'Asked twice.' })))
  check('propose.chat.bad', reply(() => api.propose(env, chat, { kind: 'poem', title: 'x', body: 'y' })))
  // Proposals changed the Wiki; the index follows before the next compile, as it does in a session.
  reindexWiki(root)
  packCase('compile.session.after', code, { input, ...pointer })
  packCase('compile.agent.after', chat, hosted('compile.agent.after', { input, tools: reading }))

  expect(seen).toEqual(golden.cases.map((entry) => entry.name))
  if (updating && updated.length) {
    // Keys in the order the file already has them (sorted), so the diff shows only what changed.
    const sorted = (value: unknown): unknown =>
      Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])])) : value
    writeFileSync(join(here, 'golden/expected.json'), `${JSON.stringify(sorted(golden), null, 2)}\n`)
    console.log(`Rewrote ${updated.length} recorded cases: ${updated.join(', ')}`)
  }
})
