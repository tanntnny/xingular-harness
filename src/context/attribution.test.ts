import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { dataRoot } from '../../tests/helpers'
import { createEnv } from '../core/env'
import { writeJson } from '../core/fs'
import { appendEvent, runDir } from '../sessions/runStore'
import type { RunEvent } from '../sessions/contracts'
import { attribution, rowText, tokensOf } from './attribution'
import type { ContextPack, Section } from '../prompt/compile'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

const RUN = 'run-context'

function section(id: string, title: string, body: string, extra: Partial<Section> = {}): Section {
  return { id, title, body, sources: [], budget: 10_000, size: body.length, cut: false, ...extra }
}

function pack(overrides: Partial<ContextPack> = {}): ContextPack {
  const sections = [
    section('harness-identity', 'Harness identity', 'You are an AI agent running in Test.'),
    section('tools', 'Tools', 'Tool guidance text here.', { sources: [{ id: 'c3', kind: 'variant', revision: 'f1', chars: 10 }], size: 120 }),
    section('reporting', 'Reporting your work', 'Report what you verified.'),
    section('system', 'Instructions', 'You draft release notes.', { sources: [{ id: 'c3', kind: 'variant', revision: 'f1' }] }),
    section('role', 'Role', 'You are the assistant.'),
    section('wiki', 'Wiki', '- projects/app/decisions'),
    section('references', 'Selected references', 'A note the person picked.')
  ]
  const sizes = {
    system: {
      'harness-identity': 60,
      tools: 120,
      reporting: 80,
      system: 60,
      role: 40
    },
    update: { wiki: 40, references: 60 },
    systemFraming: 100,
    updateFraming: 20
  }
  return {
    runId: RUN,
    profile: 'session',
    sections,
    toolGroups: [
      { group: 'History', tools: ['history_search'] },
      { group: 'Native', tools: ['read'] },
      { group: 'Connections', tools: ['mcp_list_tools'] }
    ],
    variant: { scope: 'assistant', fingerprint: 'f1' },
    compiledAt: '2026-03-09T10:00:00.000Z',
    delivery: { systemSectionIds: ['harness-identity', 'tools', 'reporting', 'system', 'role'], updatedSectionIds: ['wiki', 'references'], sizes },
    ...overrides
  }
}

function event(sequence: number, type: string, payload: unknown): RunEvent {
  return { id: `event-${sequence}`, runId: RUN, sessionId: 'session-a', sequence, timestamp: '2026-03-09T10:00:00.000Z', type: type as RunEvent['type'], payload }
}

function seed(env: { root: string }, options: { pack?: ContextPack; usage?: Record<string, unknown> | null; snapshot?: Record<string, unknown> | null } = {}) {
  writeJson(join(runDir(env.root, RUN), 'context.json'), options.pack ?? pack())
  const snapshot = options.snapshot === undefined
    ? {
        systemPrompt: 'x'.repeat(460),
        contextUpdate: 'y'.repeat(120),
        tools: [
          { name: 'history_search', description: 'Search history.', parameters: { type: 'object' } },
          { name: 'read', description: 'Read a file.', parameters: { type: 'object' } },
          { name: 'mcp_list_tools', description: 'List tools.', parameters: { type: 'object' } }
        ],
        compaction: { enabled: true, reserveTokens: 500 }
      }
    : options.snapshot
  if (snapshot) appendEvent(env.root, event(1, 'context.snapshot', snapshot))
  const usage = options.usage === undefined
    ? { contextTokens: 1_000, contextWindow: 10_000, model: 'sonnet', provider: 'anthropic', request: { index: 1 } }
    : options.usage
  if (usage) appendEvent(env.root, event(2, 'usage.updated', usage))
}

test('rows add up to the measured total, and the conversation row is the remainder', () => {
  const env = createEnv(dataRoot())
  roots.push(env.root)
  seed(env)
  const result = attribution(env, RUN)!
  expect(result.source).toBe('measured')
  expect(result.used).toBe(1_000)
  expect(result.share).toBeCloseTo(10, 5)
  const sum = result.rows.reduce((total, row) => total + row.tokens, 0)
  // The reserve is headroom beyond the measured request, so rows plus free space make the window.
  expect(sum).toBe(result.used + (result.compaction?.reserveTokens ?? 0))
  expect(sum + (result.free ?? 0)).toBe(result.window)
  expect(result.totals.foundation + result.totals.variant + result.totals.application + result.totals.conversation + result.totals.reserved).toBe(sum)
  expect(result.rows.find((row) => row.id === 'messages')?.tokens).toBeGreaterThan(0)
  expect(result.free).toBe(10_000 - 1_000 - 500)
})

test('every owner group is represented and the variant keeps its own rows', () => {
  const env = createEnv(dataRoot())
  roots.push(env.root)
  seed(env)
  const result = attribution(env, RUN)!
  const groups = new Set(result.rows.map((row) => row.group))
  expect(groups).toEqual(new Set(['foundation', 'variant', 'application', 'conversation', 'reserved']))
  expect(result.rows.find((row) => row.id === 'system')?.group).toBe('variant')
  expect(result.rows.find((row) => row.id === 'role')?.group).toBe('application')
  expect(result.rows.find((row) => row.id === 'framing')?.group).toBe('foundation')
  expect(result.rows.find((row) => row.id === 'tool-guidance')?.group).toBe('variant')
  expect(result.rows.find((row) => row.id === 'wiki')?.always).toBe(false)
  expect(result.rows.find((row) => row.id === 'tools-harness')?.tools).toEqual([{ group: 'History', count: 1 }, { group: 'Native', count: 1 }])
  expect(result.rows.find((row) => row.id === 'tools-application')?.tools).toEqual([{ group: 'Connections', count: 1 }])
})

test('an estimate larger than the measured request is scaled down, never negative', () => {
  const env = createEnv(dataRoot())
  roots.push(env.root)
  seed(env, { usage: { contextTokens: 10, contextWindow: 10_000, request: { index: 1 } } })
  const result = attribution(env, RUN)!
  expect(result.rows.every((row) => row.tokens >= 0)).toBe(true)
  expect(result.rows.find((row) => row.id === 'messages')?.tokens).toBe(0)
  const reserve = result.compaction?.reserveTokens ?? 0
  expect(result.rows.reduce((total, row) => total + row.tokens, 0) - reserve).toBeLessThanOrEqual(10)
  expect(result.note).toContain('scaled down')
})

test('a run with no measured request is an estimate with no message row', () => {
  const env = createEnv(dataRoot())
  roots.push(env.root)
  seed(env, { usage: null })
  const result = attribution(env, RUN)!
  expect(result.source).toBe('estimate')
  expect(result.rows.some((row) => row.id === 'messages')).toBe(false)
  expect(result.note).toContain('No request has been measured yet')
})

test('an unknown window reports no share and no free space', () => {
  const env = createEnv(dataRoot())
  roots.push(env.root)
  seed(env, { usage: { contextTokens: 500, request: { index: 1 } } })
  const result = attribution(env, RUN)!
  expect(result.window).toBeNull()
  expect(result.share).toBeNull()
  expect(result.free).toBeNull()
  expect(result.rows.every((row) => row.share === null)).toBe(true)
})

test('a pack recorded without sizes is marked approximate and still splits', () => {
  const env = createEnv(dataRoot())
  roots.push(env.root)
  seed(env, { pack: pack({ delivery: { systemSectionIds: ['harness-identity'], updatedSectionIds: [] } }) })
  const result = attribution(env, RUN)!
  expect(result.note).toContain('approximate')
  expect(result.rows.length).toBeGreaterThan(0)
})

test('a run without a recorded pack has no attribution', () => {
  const env = createEnv(dataRoot())
  roots.push(env.root)
  expect(attribution(env, 'run-missing')).toBeNull()
})

test('a compacted or missing reserve leaves the reserve row out', () => {
  const env = createEnv(dataRoot())
  roots.push(env.root)
  seed(env, { snapshot: { systemPrompt: 'x'.repeat(460), tools: [], compaction: { enabled: false, reserveTokens: 500 } } })
  const result = attribution(env, RUN)!
  expect(result.compaction).toBeNull()
  expect(result.rows.some((row) => row.id === 'compaction-reserve')).toBe(false)
  expect(result.free).toBe(10_000 - 1_000)
})

test('a row exposes the text the model received', () => {
  const env = createEnv(dataRoot())
  roots.push(env.root)
  seed(env)
  expect(rowText(env, RUN, 'system')?.text).toBe('You draft release notes.')
  expect(rowText(env, RUN, 'tools-harness')?.text).toContain('Native: read')
  expect(rowText(env, RUN, 'not-a-row')).toBeNull()
})

test('tokens follow the house ratio', () => {
  expect(tokensOf(0)).toBe(0)
  expect(tokensOf(1)).toBe(1)
  expect(tokensOf(4)).toBe(1)
  expect(tokensOf(5)).toBe(2)
})
