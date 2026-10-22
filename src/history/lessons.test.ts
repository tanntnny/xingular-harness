import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { freezeRun } from '../capabilities/runSnapshot'
import { onChange } from '../core/changes'
import { closeIndex } from '../core/index'
import * as attachments from '../plugins/attachments'
import { LESSONS, LESSONS_CODE } from '../plugins/firstParty'
import type { RefineRuntime } from '../refine/pi'
import type { ImproverCall } from '../refine/types'
import { runRecordSchema, type RunEventType } from '../sessions/contracts'
import { appendEvent, saveRun } from '../sessions/runStore'
import * as notes from '../wiki/notes'
import { keptLessons, Lessons } from './lessons'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) closeIndex(root)
})

const LESSON = '<experience>\ncue: when a test fails only on the second run\nlesson: look for state the first run left behind before changing the code\nevidence: the agent edited code twice; clearing the cache fixed it\nconfidence: medium, one run\n</experience>'

function setup(replies: string[], options: { on?: boolean; toolCalls?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'harness-lessons-'))
  roots.push(root)
  notes.ensureLayout(root, 'Xingular Harness')
  const calls: ImproverCall[] = []
  const lessons = new Lessons({
    root: () => root,
    runtime: {} as RefineRuntime,
    reflector: () => ({
      call: async (input) => {
        calls.push(input)
        // The evidence is gone once the call returns, so read it now.
        calls.at(-1)!.contextDir = readdirSync(input.contextDir).sort().map((name) => `${name}:${readFileSync(join(input.contextDir, name), 'utf8')}`).join('\n---\n')
        return { label: input.label, text: replies.shift() ?? 'NO_ENTRY', costUsd: 0, attempts: 1, cached: false, workspace: null }
      }
    })
  })
  const finished = (id: string, fields: Record<string, unknown> = {}) => {
    const run = runRecordSchema.parse({ id, sessionId: id, mode: 'chat', harness: 'pi', sessionType: 'structured', status: 'completed', startedAt: 'start', goal: 'Fix the flaky test', ...fields })
    saveRun(root, run)
    freezeRun(root, id, {}, { version: 1, tools: [], connectors: [], contributions: options.on === false ? [] : [`${LESSONS}/code/${LESSONS_CODE}`] })
    let sequence = 0
    const event = (type: RunEventType, payload: unknown) => appendEvent(root, { id: `${id}-${sequence}`, runId: id, sessionId: id, sequence: sequence++, timestamp: 'now', type, payload })
    for (let i = 0; i < (options.toolCalls ?? 4); i++) event('tool.started', { toolCallId: `t${i}`, name: 'bash', text: 'npm test' })
    event('completed', {})
    return run
  }
  return { root, lessons, calls, finished }
}

describe('lessons from finished runs', () => {
  it('keeps one lesson as a Wiki note, with a version trail and a change notice', async () => {
    const { root, lessons, calls, finished } = setup([LESSON])
    const changes: { id: string; actor: string }[] = []
    const stop = onChange((change) => void changes.push({ id: change.id, actor: change.actor }))
    try {
      expect(await lessons.reflect(finished('r1').id)).toEqual({ kind: 'written', path: 'library/lessons/when-a-test-fails-only-on-the-second-run' })
    } finally {
      stop()
    }
    expect(calls[0]!.label).toBe('lesson-r1')
    expect(calls[0]!.contextDir).toContain('Fix the flaky test')
    expect(calls[0]!.contextDir).toContain('(no lessons kept yet)')
    expect(calls[0]!.mission).toContain('NO_ENTRY')
    expect(changes).toEqual([{ id: 'library/lessons/when-a-test-fails-only-on-the-second-run', actor: 'reflection' }])
    const [kept] = keptLessons(root)
    expect(kept).toMatchObject({ cue: 'when a test fails only on the second run', sources: ['r1'] })
    expect(kept!.body).toContain('**Do:** look for state the first run left behind')
    expect(await lessons.reflect('r1')).toEqual({ kind: 'skipped', reason: 'already reflected' })
  })

  it('adds the run to an existing lesson when the reflection says it is the same', async () => {
    const { root, lessons, calls, finished } = setup([LESSON, 'SAME library/lessons/when-a-test-fails-only-on-the-second-run'])
    await lessons.reflect(finished('r1').id)
    expect(await lessons.reflect(finished('r2').id)).toEqual({ kind: 'same', path: 'library/lessons/when-a-test-fails-only-on-the-second-run' })
    expect(calls[1]!.contextDir).toContain('library/lessons/when-a-test-fails-only-on-the-second-run -- when a test fails only on the second run')
    expect(keptLessons(root).map((lesson) => lesson.sources)).toEqual([['r1', 'r2']])
    expect(notes.versions(root, 'library/lessons/when-a-test-fails-only-on-the-second-run')).toHaveLength(1)
  })

  it('writes nothing for NO_ENTRY, a credential, a grader marker or a lesson over the limit', async () => {
    const secret = LESSON.replace('clearing the cache fixed it', 'the key sk-ant-123 worked')
    const long = LESSON.replace('look for state', `look for state ${'x'.repeat(2_100)}`)
    const { root, lessons, finished } = setup(['NO_ENTRY', secret, long])
    expect(await lessons.reflect(finished('r1').id)).toEqual({ kind: 'no_entry' })
    expect(await lessons.reflect(finished('r2').id)).toEqual({ kind: 'skipped', reason: 'lesson looked like it held a credential' })
    expect(await lessons.reflect(finished('r3').id)).toEqual({ kind: 'skipped', reason: 'lesson too long' })
    expect(keptLessons(root)).toEqual([])
  })

  it('reflects only when the plugin is on and the run did enough', async () => {
    const off = setup([LESSON], { on: false })
    expect(await off.lessons.reflect(off.finished('r1').id)).toEqual({ kind: 'skipped', reason: 'plugin off' })
    const short = setup([LESSON], { toolCalls: 2 })
    expect(await short.lessons.reflect(short.finished('r1').id)).toEqual({ kind: 'skipped', reason: 'too few tool calls' })
    attachments.save(short.root, { ...attachments.load(short.root), settings: { [LESSONS]: { minToolCalls: 2 } } })
    expect(await short.lessons.reflect('r1')).toMatchObject({ kind: 'written' })
    const full = setup([LESSON, LESSON])
    attachments.save(full.root, { ...attachments.load(full.root), settings: { [LESSONS]: { maxLessons: 1 } } })
    await full.lessons.reflect(full.finished('r1').id)
    expect(await full.lessons.reflect(full.finished('r2').id)).toEqual({ kind: 'skipped', reason: 'lesson limit reached' })
    expect(off.calls.length + short.calls.length + full.calls.length).toBe(2)
  })

  it('never queues a subagent, a refinement or a reflection run, and stops when closed', async () => {
    const { lessons, calls, finished } = setup([LESSON])
    lessons.consider(finished('child', { parentRunId: 'p', relation: 'subagent' }))
    lessons.consider(finished('probe', { trigger: 'probe' }))
    lessons.consider(finished('improver', { trigger: 'improver' }))
    lessons.consider(finished('reflection', { trigger: 'reflection' }))
    lessons.consider(finished('running', { status: 'running' }))
    await lessons.idle()
    expect(calls).toEqual([])
    lessons.consider(finished('top'))
    await lessons.idle()
    expect(calls.map((call) => call.label)).toEqual(['lesson-top'])
    await lessons.close()
    lessons.consider(finished('late'))
    await lessons.idle()
    expect(calls).toHaveLength(1)
  })
})
