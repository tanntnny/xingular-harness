import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CONTEXT_MESSAGE_TYPE, CONTEXT_SNAPSHOT_KEY } from '../prompt/compile'
import { PLAN_INSTRUCTIONS, PLAN_SECTION_ID, parseProposedPlan, planModeTools, planRefusal, planSection } from './planMode'

function history(sectionIds: string[]): string {
  const file = join(mkdtempSync(join(tmpdir(), 'plan-history-')), 'session.jsonl')
  const snapshot = sectionIds.map((id) => ({ id, title: id, body: 'x', sources: [], budget: 100, size: 1, cut: false }))
  writeFileSync(file, [
    JSON.stringify({ type: 'session', id: 'session' }),
    JSON.stringify({ type: 'custom_message', id: 'c1', parentId: null, customType: CONTEXT_MESSAGE_TYPE, details: { [CONTEXT_SNAPSHOT_KEY]: snapshot } })
  ].join('\n'))
  return file
}

describe('plan mode', () => {
  it('keeps read-only inspection, questions and recall, plus provider tools marked read-only', () => {
    const normal = ['read', 'bash', 'edit', 'write', 'grep', 'ask_user', 'wiki_search', 'memory_append', 'spawn_subagent', 'files_read', 'files_write', 'skill_load']
    expect(planModeTools(normal, ['files_read'])).toEqual(['read', 'grep', 'ask_user', 'wiki_search', 'files_read', 'skill_load'])
  })

  it('refuses changes, commands, memory writes and delegation with a reason the model can act on', () => {
    const readOnly = new Set(['files_read'])
    for (const tool of ['read', 'grep', 'wiki_read', 'files_read', 'ask_user']) expect(planRefusal(tool, readOnly), tool).toBeNull()
    for (const tool of ['bash', 'write', 'edit', 'memory_append', 'wiki_propose', 'spawn_subagent', 'mcp_call_tool', 'files_write']) {
      expect(planRefusal(tool, readOnly), tool).toContain('Plan mode is research-only')
    }
  })

  it('allows only provider calls whose arguments are explicitly classified as research-safe', () => {
    const safeBrowserCall = (input: Record<string, unknown>) => input.op === 'navigate' || input.op === 'scroll'
    expect(planRefusal('browser', new Set(), { op: 'navigate' }, safeBrowserCall)).toBeNull()
    expect(planRefusal('browser', new Set(), { op: 'click' }, safeBrowserCall)).toContain('research-only')
    expect(planRefusal('browser', new Set(), { op: 'submit' }, safeBrowserCall)).toContain('research-only')
  })

  it('adds its instructions while on, withdraws them once after, and is absent otherwise', () => {
    expect(planSection(true, null)).toMatchObject({ id: PLAN_SECTION_ID, body: PLAN_INSTRUCTIONS, dynamic: true })
    expect(PLAN_INSTRUCTIONS).toContain('<proposed_plan>')
    expect(planSection(false, null)).toBeNull()
    expect(planSection(false, history(['blocks']))).toBeNull()
    expect(planSection(false, history(['blocks', PLAN_SECTION_ID]))).toMatchObject({ id: PLAN_SECTION_ID, body: null, dynamic: true })
  })
})

describe('parseProposedPlan', () => {
  it('returns the title, body and surrounding text of a closed block', () => {
    expect(parseProposedPlan('Here is what I found.\n<proposed_plan>\n# Add cache\n\n1. Edit `src/a.ts`\n</proposed_plan>\nAsk me to start.')).toEqual({
      before: 'Here is what I found.',
      title: 'Add cache',
      body: '1. Edit `src/a.ts`',
      after: 'Ask me to start.',
      complete: true
    })
  })

  it('treats a missing closing tag as a plan still streaming', () => {
    expect(parseProposedPlan('<proposed_plan># Draft\n\n1. Read')).toMatchObject({ title: 'Draft', body: '1. Read', after: '', complete: false })
  })

  it('falls back to a generic title when the block has no heading', () => {
    expect(parseProposedPlan('<proposed_plan>1. Only steps</proposed_plan>')).toMatchObject({ title: 'Plan', body: '1. Only steps', complete: true })
  })

  it('uses the last block when a reply has several', () => {
    const plan = parseProposedPlan('<proposed_plan># First</proposed_plan>\n<proposed_plan># Second</proposed_plan>')
    expect(plan).toMatchObject({ title: 'Second', complete: true })
    expect(plan?.before).toContain('# First')
  })

  it('returns null when the reply has no block', () => {
    expect(parseProposedPlan('Just an answer.')).toBeNull()
  })
})
