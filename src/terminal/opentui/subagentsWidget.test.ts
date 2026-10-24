import type { Theme } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { createHarnessTheme } from '../tui/theme'
import { subagentsWidget } from './subagentsWidget'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)

function plain(lines: ReturnType<typeof subagentsWidget>): string[] {
  return lines.map(line => line.spans.map(span => span.text).join(''))
}

describe('subagentsWidget', () => {
  it('shows active tasks first, with readable status, activity and overflow', () => {
    const items = Array.from({ length: 5 }, (_, index) => ({
      id: `run-${index}`, parentRunId: 'parent', relation: 'subagent' as const,
      goal: `Task ${index}`, status: index === 4 ? 'running' as const : 'completed' as const,
      startedAt: `2026-10-23T00:00:0${index}.000Z`, endedAt: index === 4 ? null : '2026-10-23T00:00:05.000Z',
      activity: index === 4 ? 'read' : 'Completed'
    }))

    const lines = plain(subagentsWidget(items, 100, theme, Date.parse('2026-10-23T00:00:10.000Z')))
    expect(lines).toHaveLength(5)
    expect(lines[0]).toContain('1 active · 4 finished · /plugin:subagents')
    expect(lines[1]).toContain('Task 4 · running · read · 6s')
    expect(lines.at(-1)).toContain('+2 more · /plugin:subagents')
  })

  it('sanitizes task and activity strings and fits rows to the terminal width', () => {
    const lines = plain(subagentsWidget([{
      id: 'run', parentRunId: 'parent', relation: 'subagent', goal: '\u001b[31mSensitive task\u001b[0m',
      status: 'waiting_for_approval', startedAt: '2026-10-23T00:00:00.000Z', endedAt: null,
      activity: 'Waiting\nfor approval'
    }], 32, theme, Date.parse('2026-10-23T00:00:04.000Z')))

    expect(lines.join('\n')).not.toContain('\u001b')
    expect(lines.join('\n')).toContain('approval')
    expect(lines.every(line => line.length <= 32)).toBe(true)
  })
})
