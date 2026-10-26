import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CONTEXT_MESSAGE_TYPE, CONTEXT_SNAPSHOT_KEY } from '../prompt/compile'
import { GET_CAPABILITIES } from '../tools/getCapabilities'
import { deniedPlanBashCommand, normalModeTools, PLAN_INSTRUCTIONS, PLAN_SECTION_ID, parseProposedPlan, planModeTools, planRefusal, planSection, QUESTION_TOOL_NAMES } from './planMode'

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
  it('keeps question tools out of normal mode and available to an eligible plan', () => {
    const registered = ['read', 'bash', 'ask_user', 'ask_user_question', 'spawn_subagent', 'wait_subagents']
    const normal = normalModeTools(registered)
    expect(normal).toEqual(['read', 'bash', 'spawn_subagent', 'wait_subagents'])
    expect(QUESTION_TOOL_NAMES).toEqual(new Set(['ask_user', 'ask_user_question']))
    expect(planModeTools(normal, [], registered)).toEqual(['read', 'bash', 'spawn_subagent', 'wait_subagents', 'ask_user', 'ask_user_question'])
  })

  it('keeps read-only inspection and recall plus provider tools marked read-only', () => {
    const normal = ['read', 'bash', 'edit', 'write', 'grep', 'ask_user', 'wiki_search', 'memory_append', 'spawn_subagent', 'files_read', 'files_write', 'skill_load', GET_CAPABILITIES]
    expect(planModeTools(normal, ['files_read'])).toEqual(['read', 'bash', 'grep', 'ask_user', 'wiki_search', 'spawn_subagent', 'files_read', 'skill_load', GET_CAPABILITIES])
  })

  it('refuses changes, memory writes and unclassified delegation with a reason the model can act on', () => {
    const readOnly = new Set(['files_read'])
    for (const tool of ['read', 'grep', 'wiki_read', 'files_read', 'ask_user', 'wait_subagents']) expect(planRefusal(tool, readOnly), tool).toBeNull()
    for (const tool of ['write', 'edit', 'memory_append', 'wiki_propose', 'spawn_subagent', 'mcp_call_tool', 'files_write']) {
      expect(planRefusal(tool, readOnly), tool).toContain('Plan mode is research-only')
    }
  })

  it('admits Bash for the read-only sandbox but refuses outside scope and system-acting commands', () => {
    for (const command of ['git log --oneline -5', 'rg -n planRefusal src | head', 'ls -la && cat package.json']) {
      expect(planRefusal('bash', new Set(), { command }), command).toBeNull()
    }
    expect(planRefusal('bash', new Set(), { command: 'ls', workspaceWriteScope: 'outside' })).toContain('Plan mode Bash is read-only')
    for (const command of ['sudo ls', 'ls; osascript -e 1', 'cat x | /usr/bin/ssh host', 'echo $(defaults read x)', 'true && kill 1', '(open .)']) {
      expect(planRefusal('bash', new Set(), { command }), command).toContain('Plan mode Bash is read-only')
    }
    expect(deniedPlanBashCommand('git open-pr')).toBeNull()
  })

  it('allows delegation only when the tool validates a named research profile', () => {
    const eligible = (args: Record<string, unknown>) => args.agent === 'explorer'
    expect(planRefusal('spawn_subagent', new Set(), { agent: 'explorer' }, eligible)).toBeNull()
    expect(planRefusal('spawn_subagent', new Set(), { agent: 'worker' }, eligible)).toContain('research-only')
  })

  it('allows only provider calls whose arguments are explicitly classified as research-safe', () => {
    const safeBrowserCall = (input: Record<string, unknown>) => input.op === 'navigate' || input.op === 'scroll'
    expect(planRefusal('browser', new Set(), { op: 'navigate' }, safeBrowserCall)).toBeNull()
    expect(planRefusal('browser', new Set(), { op: 'click' }, safeBrowserCall)).toContain('research-only')
    expect(planRefusal('browser', new Set(), { op: 'submit' }, safeBrowserCall)).toContain('research-only')
  })

  it('adds its instructions while on, withdraws them once after, and is absent otherwise', () => {
    expect(planSection(true, null)).toMatchObject({ id: PLAN_SECTION_ID, body: PLAN_INSTRUCTIONS, budget: 4_000, dynamic: true })
    expect(planSection(true, null, true)?.body).toContain('read-only research subagent')
    expect(PLAN_INSTRUCTIONS).toContain('<proposed_plan>')
    expect(PLAN_INSTRUCTIONS).toContain('path:line')
    expect(PLAN_INSTRUCTIONS).toContain('read-only sandbox with no network')
    expect(PLAN_INSTRUCTIONS).toContain('Start each plan with a concise `Goal` or `Summary` section')
    expect(PLAN_INSTRUCTIONS).toContain('Scale detail, not word count')
    expect(PLAN_INSTRUCTIONS).toContain('specific verification')
    expect(PLAN_INSTRUCTIONS).toContain('expected results')
    expect(PLAN_INSTRUCTIONS).toContain('only to a named profile in the plan-specific Subagents list')
    expect(PLAN_INSTRUCTIONS).toContain('contextual `uiSketch` wireframes')
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
