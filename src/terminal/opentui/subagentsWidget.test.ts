import { describe, expect, it } from 'vitest'

import type { TerminalSubagentActivity } from '../subagentMonitor'
import { subagentRoster, subagentRowText } from './subagentsWidget'

function child(index: number, extra: Partial<TerminalSubagentActivity> = {}): TerminalSubagentActivity {
  return {
    id: `run-${index}`, parentRunId: 'parent', relation: 'subagent', goal: `Task ${index}`, status: 'completed',
    startedAt: `2026-10-23T00:00:0${index}.000Z`, endedAt: '2026-10-23T00:00:09.000Z', activity: 'Completed',
    title: `Task ${index}`, todo: null, usage: null, ...extra
  }
}

describe('subagentRoster', () => {
  it('leaves the main agent’s row to the /subagents page', () => {
    expect(subagentRoster([child(1, { relation: 'main', profile: { name: 'main', color: 'main' } })], 80)).toBeNull()
    expect(subagentRoster([child(1, { relation: 'main' }), child(2)], 80)?.rows.map(row => row.id)).toEqual(['run-2'])
  })

  it('has no heading; each row is mark, profile, title, then tasks', () => {
    const roster = subagentRoster([
      child(0),
      child(1, { status: 'running', profile: { name: 'worker', color: 'green' }, title: 'Fix login redirect', todo: { done: 2, total: 5 } }),
      child(2, { status: 'waiting_for_approval', profile: { name: 'explorer', color: 'cyan' } }),
      child(3, { status: 'failed' }),
      child(4, { status: 'queued' })
    ], 100)!
    expect(roster.rows.map(subagentRowText)).toEqual([
      '· worker  Fix login redirect  2 of 5 tasks',
      '● explorer  Task 2',
      '○ subagent  Task 4'
    ])
    expect(roster.rows[0]).toMatchObject({ tone: 'warning', color: 'green' })
    expect(roster.rows[1]).toMatchObject({ tone: 'accent', color: 'cyan' })
    expect(roster.rows[2]).toMatchObject({ tone: 'muted', color: null })
    expect(roster.overflow).toBe('+2 more · /subagents')
    expect(JSON.stringify(roster)).not.toContain('Subagents ·')
  })

  it('shows the running frame it is given, and only running rows take it', () => {
    const roster = subagentRoster([child(0, { status: 'running' }), child(1, { status: 'queued' })], 100, '●')!
    expect(roster.rows.map(row => row.mark)).toEqual(['●', '○'])
  })

  it('marks finished rows and leaves out tasks when there is no todo', () => {
    const roster = subagentRoster([child(0, { todo: { done: 3, total: 3 } }), child(1, { status: 'failed' }), child(2, { status: 'interrupted' })], 100)!
    expect(roster.rows.map(row => [row.mark, row.tone, row.tasks])).toEqual([['✓', 'success', '3 of 3 tasks'], ['✕', 'error', null], ['!', 'muted', null]])
    expect(roster.overflow).toBeNull()
    expect(subagentRoster([], 100)).toBeNull()
  })

  it('cleans titles and cuts the title first on a narrow terminal', () => {
    const roster = subagentRoster([child(0, {
      status: 'running', profile: { name: 'worker', color: 'green' }, title: '\u001b[31mA very long title\nhere\u001b[0m', todo: { done: 1, total: 4 }
    })], 34)!
    const text = subagentRowText(roster.rows[0]!)
    expect(text).not.toContain('\u001b')
    expect(text.startsWith('✓ worker  A very')).toBe(false)
    expect(text).toMatch(/^· worker {2}A very.*… {2}1 of 4 tasks$/u)
    expect(text.length).toBeLessThanOrEqual(34)
  })
})
