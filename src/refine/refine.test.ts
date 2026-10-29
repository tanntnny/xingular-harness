import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import * as store from '../variant/store'
import { DemoExecutor, DemoImprover, demoBaseVariant, demoTasks } from './demo'
import * as evidence from './evidence'
import { Library } from './library'
import { Ledger, BudgetError } from './ledger'
import * as P from './prompts'
import { runRefinement } from './runner'
import { anonId, assignIds, parseExperience } from './selection'
import type { Improver, ImproverCall, RefineTask } from './types'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'refine-'))
  store.seed(root, 'demo', demoBaseVariant())
  return { root, tasks: demoTasks(root), executor: new DemoExecutor(root), improver: new DemoImprover() }
}

describe('refinement end to end', () => {
  for (const mode of ['parallel', 'sequential'] as const) {
    for (const k of [1, 2]) {
      it(`${mode} k=${k} keeps the budget identity and delivers the signed total`, async () => {
        const { root, tasks, executor, improver } = setup()
        const expected: Record<string, string> = { 'ledger-1': 'Total: 85.15\n', 'ledger-2': 'Total: 20.25\n' }
        for (const task of tasks) {
          const summary = await runRefinement({ root, id: `${task.id}-${mode}-${k}`, task, k, mode, executor, improver })
          expect(summary.status).toBe('ok')
          expect(summary.recursion?.ledger).toMatchObject({ R: 4 * k, P: 3 * k })
          const chosen = summary.selection!
          expect(readFileSync(join(chosen.chosenDir, 'answer.txt'), 'utf8')).toBe(expected[task.id])
          expect(summary.chosenIsBase).toBe(false)
          expect(store.exists(root, 'demo', summary.chosenFingerprint!)).toBe(true)
          // A refinement never moves the head; adopting is a separate step.
          expect(store.head(root, 'demo')?.fingerprint).toBe(summary.baseFingerprint)
          expect(summary.libraryEntry).toBeTruthy()
        }
        const library = new Library(root, 'demo', 'accounting')
        expect(library.entries()).toEqual(['ledger-1', 'ledger-2'])
        expect(readFileSync(library.index, 'utf8')).toContain('When a ledger includes credits and debits')
        // No selector session at k=1.
        expect(improver.calls.some((label) => label.startsWith('select.'))).toBe(k > 1)
      })
    }
  }

  it('gives the second task the first task\'s library, and never the answer key', async () => {
    const { root, tasks, executor } = setup()
    const seen: string[] = []
    const improver = new DemoImprover()
    const spy: Improver = {
      call: (input: ImproverCall) => {
        if (input.label.startsWith('inv1')) {
          seen.push(existsSync(join(input.contextDir, 'library', 'INDEX.md')) ? 'library' : 'empty')
          expect(existsSync(join(input.contextDir, 'source', 'reference_answer.txt'))).toBe(false)
        }
        return improver.call(input)
      }
    }
    for (const task of tasks) await runRefinement({ root, id: task.id, task, k: 1, mode: 'parallel', executor, improver: spy })
    expect(seen).toEqual(['empty', 'library'])
  })

  it('retries an invalid proposal once with the validator\'s message, then falls back', async () => {
    const { root, tasks, executor } = setup()
    const missions: string[] = []
    const bad: Improver = {
      async call(input) {
        missions.push(input.mission)
        if (input.label.startsWith('experience.')) return { label: input.label, text: 'NO_ENTRY', costUsd: 0, attempts: 1, cached: false, workspace: null }
        const dir = mkdtempSync(join(tmpdir(), 'bad-'))
        writeFileSync(join(dir, 'systemprompt.md'), 'x')
        writeFileSync(join(dir, 'guardrails.md'), '')
        // Drops the script the executor requires.
        return { label: input.label, text: '<notes>x</notes>', costUsd: 0.01, attempts: 1, cached: false, workspace: dir }
      }
    }
    const summary = await runRefinement({ root, id: 'bad', task: tasks[0]!, k: 1, mode: 'parallel', executor, improver: bad })
    expect(summary.recursion?.fellBack.sort()).toEqual(['agg1', 'dom1', 'inv1'])
    expect(missions.some((mission) => mission.includes('YOUR PREVIOUS ATTEMPT WAS REJECTED') && mission.includes('requires scripts/summarize.mjs'))).toBe(true)
    expect(summary.recursion?.ledger).toMatchObject({ R: 4, P: 3 })
    expect(summary.chosenIsBase).toBe(true)
    expect(summary.libraryEntry).toBeNull()
  })

  it('records a failed refinement when no base rollout works', async () => {
    const { root, tasks, improver } = setup()
    const broken = new DemoExecutor(root)
    broken.execute = async (_task, _dir, label, runId) => ({ label, runId, dir: root, ok: false, delivered: false, costUsd: 0, wallMs: 0, error: 'down' })
    const summary = await runRefinement({ root, id: 'down', task: tasks[0]!, k: 1, mode: 'parallel', executor: broken, improver })
    expect(summary.status).toBe('failed')
    expect(summary.errors).toContain('no base rollout produced anything')
  })
})

describe('guards and parsing', () => {
  it('refuses grader output and answer keys in evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-'))
    writeFileSync(join(dir, 'notes.json'), '{"pass_rate": 1}')
    expect(() => evidence.assertNoGraderVerdicts(dir)).toThrow(/grader verdict/)
    expect(() => evidence.assertVariantHasNoGraderVerdicts({ 'memory.md': 'review_verdict: approved' })).toThrow()
    expect(() => evidence.assertNoLeakPaths(dir, ['notes.json'])).toThrow(/answer-key/)
  })

  it('refuses work prompts that describe measurement', () => {
    expect(() => P.checkWorkPrompts({ work: 'maximise the rubric score' })).toThrow(/must describe the WORK/)
  })

  it('refuses guidance that describes measurement or is too long, and trims the rest', () => {
    expect(() => P.checkGuidance('raise my score on totals')).toThrow(/must describe the WORK/)
    expect(() => P.checkGuidance('x'.repeat(P.GUIDANCE_MAX + 1))).toThrow(/at most/)
    expect(P.checkGuidance('  how it checks totals  ')).toBe('how it checks totals')
    expect(P.focus('')).toBe('')
  })

  for (const mode of ['parallel', 'sequential'] as const) {
    it(`${mode}: guidance reaches improvers and composers, never the selector or the reflector`, async () => {
      const { root, tasks, executor } = setup()
      const missions: { label: string; mission: string }[] = []
      const inner = new DemoImprover()
      const improver: Improver = { call: (input: ImproverCall) => { missions.push({ label: input.label, mission: input.mission }); return inner.call(input) } }
      const guidance = 'how the agent reconciles line items before it writes the total'
      const task = { ...tasks[0]!, guidance }
      const summary = await runRefinement({ root, id: `guided-${mode}`, task, k: 2, mode, executor, improver })
      expect(summary.status).toBe('ok')
      expect(summary.guidance).toBe(guidance)
      expect(summary.recursion?.ledger).toMatchObject({ R: 8, P: 6 })
      const withGuidance = missions.filter((entry) => entry.mission.includes(guidance)).map((entry) => entry.label)
      const without = missions.filter((entry) => !entry.mission.includes(guidance)).map((entry) => entry.label)
      expect(withGuidance.length).toBe(6)
      expect(without.length).toBeGreaterThan(0)
      for (const entry of missions.filter((item) => item.mission.includes('You are choosing which of') || item.mission.includes('complete record of one improvement round'))) {
        expect(entry.mission).not.toContain(guidance)
        expect(entry.mission).not.toContain('WHERE THE PERSON ASKED YOU TO LOOK')
      }
    })
  }

  it('shuffles candidate ids deterministically', () => {
    expect(anonId(0)).toBe('A')
    expect(anonId(26)).toBe('AA')
    const a = assignIds(['agg1', 'agg2', 'agg3'], 't', 3, 'agg')
    expect(assignIds(['agg3', 'agg1', 'agg2'], 't', 3, 'agg')).toEqual(a)
    expect(Object.values(a).sort()).toEqual(['agg1', 'agg2', 'agg3'])
  })

  it('reads an experience block, and keeps only edits when there is no lesson', () => {
    expect(parseExperience('<edits>e</edits>\n<experience>\ncue: c\nlesson: l\nevidence: v\nconfidence: low\n</experience>')).toEqual({ cue: 'c', lesson: 'l', evidence: 'v', confidence: 'low', edits: 'e' })
    expect(parseExperience('<edits>e</edits>\nNO_ENTRY')).toEqual({ edits: 'e' })
  })

  it('catches a broken budget identity', () => {
    const ledger = new Ledger('agg', 't', 1)
    ledger.rollout('base1')
    ledger.rollout('base1')
    expect(() => ledger.assertIdentity()).toThrow(BudgetError)
  })

  it('builds missions that point at the evidence on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'mission-'))
    const task: RefineTask = { id: 't', scope: 's', prompt: 'Do it.' }
    const folder = evidence.build(join(root, 'ctx'), { task, executor: new DemoExecutor(root) })
    const text = evidence.mission(folder, P.propose({ work: 'drafting' }, 'INV'))
    expect(text).toContain('# YOUR EVIDENCE')
    expect(text).toContain('context/task.md')
    expect(text).toContain('`plugins/<name>.ts`')
  })
})
