// Lessons from finished runs. When the `lessons` plugin is on for a run's caller, a completed
// top-level run is reflected on in the background: a file-tools-only session reads its record and
// may keep one general lesson as a Wiki note under `library/lessons/`. The lesson shape and the
// answer-free guards are refinement's (harness²); the caps follow OMP's memory budget.
//
// Lessons are reference notes (INV-MEM-1). They never enter the stable prefix and never change a
// harness tree; something that should become an instruction goes through refinement and `adopt`.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadRun as loadCapabilities } from '../capabilities/runSnapshot'
import { log } from '../core/bus'
import * as frontmatter from '../core/frontmatter'
import { looksSecret } from '../core/secrets'
import * as attachments from '../plugins/attachments'
import { LESSONS, LESSONS_CODE, LESSONS_SETTINGS, settingValue } from '../plugins/firstParty'
import { assertNoGraderVerdicts, assertTreeHasNoGraderVerdicts } from '../refine/evidence'
import { hasExperience, type Experience } from '../refine/library'
import { PiImprover, type RefineRuntime } from '../refine/pi'
import { parseExperience } from '../refine/selection'
import { renderEvents } from '../refine/trajectory'
import type { Improver } from '../refine/types'
import type { RunRecord } from '../sessions/contracts'
import { executionEvents, findRun, readEvents } from '../sessions/runStore'
import * as notes from '../wiki/notes'
import { lessonMission, REFLECTION_IDENTITY } from './lessonPrompt'

export const REFLECTION_TRIGGER = 'reflection'
export const LESSONS_FOLDER = 'library/lessons'
/** Runs that are themselves part of improving the harness are never reflected on. */
const SKIPPED_TRIGGERS = new Set(['probe', 'improver', REFLECTION_TRIGGER])
const REFLECTION_TOOLS = ['read', 'grep', 'find', 'ls']
/** The same floor refinement keeps for a trajectory (INV-REF-8). */
const OBS_TRUNC = 10_000

export type LessonOutcome =
  | { kind: 'written'; path: string }
  | { kind: 'same'; path: string }
  | { kind: 'no_entry' }
  | { kind: 'skipped'; reason: string }

export interface LessonsOptions {
  root: () => string
  runtime: RefineRuntime
  /** Builds the reflection session for one run. Tests pass a fake; by default it is a `PiImprover`. */
  reflector?: (run: RunRecord, model: string | null, signal: AbortSignal) => Improver
}

interface Limits {
  minToolCalls: number
  maxLessons: number
  maxChars: number
}

interface KeptLesson {
  path: string
  cue: string
  sources: string[]
  front: Record<string, unknown>
  body: string
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'lesson'

/** The lessons the Wiki keeps now. */
export function keptLessons(root: string): KeptLesson[] {
  return notes.paths(root).filter((path) => path.startsWith(`${LESSONS_FOLDER}/`)).flatMap((path) => {
    try {
      const text = readFileSync(join(notes.wikiDir(root), `${path}.md`), 'utf8')
      const parsed = frontmatter.parse(text)
      const front = parsed?.front ?? {}
      const sources = Array.isArray(front.sources) ? front.sources.filter((id): id is string => typeof id === 'string') : []
      return [{ path, cue: typeof front.cue === 'string' ? front.cue : '', sources, front, body: parsed?.body ?? text }]
    } catch {
      return []
    }
  })
}

/** The model the run used, as Pi names it, from its last usage report. */
function modelOf(root: string, runId: string): string | null {
  const usage = readEvents(root, runId).filter((event) => event.type === 'usage.updated').at(-1)?.payload as { model?: unknown; provider?: unknown } | undefined
  return typeof usage?.model === 'string' && typeof usage.provider === 'string' ? `${usage.provider}/${usage.model}` : null
}

function lessonNote(experience: Experience, sources: string[]): string {
  const title = experience.cue.length > 80 ? `${experience.cue.slice(0, 77).trimEnd()}…` : experience.cue
  const body = [`# ${title}`, '', `**When:** ${experience.cue}`, '', `**Do:** ${experience.lesson}`, '', `**Evidence:** ${experience.evidence}`].join('\n')
  return frontmatter.serialize({ title, cue: experience.cue, confidence: experience.confidence ?? null, sources }, body)
}

export class Lessons {
  private readonly queue: string[] = []
  private readonly abort = new AbortController()
  private draining: Promise<void> | null = null
  private closed = false

  constructor(private readonly options: LessonsOptions) {}

  /** Called when a run completes. Cheap: the work happens later, one run at a time. */
  consider(run: RunRecord | null): void {
    if (this.closed || !run || run.status !== 'completed' || run.parentRunId || run.relation) return
    if (run.trigger && SKIPPED_TRIGGERS.has(run.trigger)) return
    if (this.queue.includes(run.id)) return
    this.queue.push(run.id)
    this.draining ??= this.drain().finally(() => {
      this.draining = null
    })
  }

  /** Resolves when everything queued so far was reflected on. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining
  }

  async close(): Promise<void> {
    this.closed = true
    this.queue.length = 0
    this.abort.abort()
    await this.draining?.catch(() => undefined)
  }

  private async drain(): Promise<void> {
    while (this.queue.length && !this.closed) {
      const runId = this.queue.shift()!
      try {
        const outcome = await this.reflect(runId)
        if (outcome.kind !== 'skipped') log(`lessons: run ${runId}: ${outcome.kind}${'path' in outcome ? ` ${outcome.path}` : ''}`)
      } catch (error) {
        log(`lessons: run ${runId} was not reflected on`, error instanceof Error ? error.message : String(error))
      }
    }
  }

  /** The plugin's settings for this run's caller, or null when it is off for them. */
  private limits(root: string, runId: string): Limits | null {
    const contribution = `${LESSONS}/code/${LESSONS_CODE}`
    if (!loadCapabilities(root, runId)?.contributions.includes(contribution)) return null
    const saved = attachments.load(root).settings[LESSONS]
    const value = (key: string): number => settingValue(LESSONS_SETTINGS.find((setting) => setting.key === key)!, saved)
    return { minToolCalls: value('minToolCalls'), maxLessons: value('maxLessons'), maxChars: value('maxChars') }
  }

  /** Reflects on one finished run. Exposed for tests and for a host that wants to ask directly. */
  async reflect(runId: string): Promise<LessonOutcome> {
    const root = this.options.root()
    const run = findRun(root, runId)
    if (!run || run.status !== 'completed') return { kind: 'skipped', reason: 'not completed' }
    const limits = this.limits(root, runId)
    if (!limits) return { kind: 'skipped', reason: 'plugin off' }
    const events = executionEvents(readEvents(root, runId))
    if (events.filter((event) => event.type === 'tool.started').length < limits.minToolCalls) return { kind: 'skipped', reason: 'too few tool calls' }
    const kept = keptLessons(root)
    if (kept.some((lesson) => lesson.sources.includes(runId))) return { kind: 'skipped', reason: 'already reflected' }
    if (kept.length >= limits.maxLessons) return { kind: 'skipped', reason: 'lesson limit reached' }

    const context = mkdtempSync(join(tmpdir(), 'harness-lesson-'))
    try {
      const goal = run.goal ? `# Request\n\n${run.goal}\n\n# Record\n\n` : '# Record\n\n'
      writeFileSync(join(context, 'run.md'), `${goal}${renderEvents(events, { obsTrunc: OBS_TRUNC })}\n`)
      writeFileSync(join(context, 'lessons.md'), kept.length ? `${kept.map((lesson) => `${lesson.path} -- ${lesson.cue}`).join('\n')}\n` : '(no lessons kept yet)\n')
      assertNoGraderVerdicts(context)
      const reflector = this.options.reflector?.(run, modelOf(root, runId), this.abort.signal)
        ?? new PiImprover(this.options.runtime, join(root, 'reflection'), { accountId: run.accountId, model: modelOf(root, runId), effort: 'medium' }, this.abort.signal, { trigger: REFLECTION_TRIGGER, identity: REFLECTION_IDENTITY, tools: REFLECTION_TOOLS })
      const reply = await reflector.call({ mission: lessonMission(), contextDir: context, label: `lesson-${runId}`, signal: this.abort.signal })
      return this.keep(root, runId, reply.text, kept, limits)
    } finally {
      rmSync(context, { recursive: true, force: true })
    }
  }

  private keep(root: string, runId: string, text: string, kept: KeptLesson[], limits: Limits): LessonOutcome {
    if (/^\s*NO_ENTRY\s*$/m.test(text) && !text.includes('<experience>')) return { kind: 'no_entry' }
    const same = /^\s*SAME\s+(\S+)\s*$/m.exec(text)?.[1]?.replace(/\.md$/, '')
    if (same) {
      const lesson = kept.find((entry) => entry.path === same)
      if (!lesson) return { kind: 'skipped', reason: `named an unknown lesson ${same}` }
      notes.write(root, lesson.path, frontmatter.serialize({ ...lesson.front, sources: [...lesson.sources, runId] }, lesson.body), { actor: REFLECTION_TRIGGER, reason: `Seen again in run ${runId}` })
      return { kind: 'same', path: lesson.path }
    }
    const experience = parseExperience(text)
    if (!hasExperience(experience)) return { kind: 'no_entry' }
    const body = lessonNote(experience, [runId])
    if (`${experience.cue}${experience.lesson}${experience.evidence}`.length > limits.maxChars) return { kind: 'skipped', reason: 'lesson too long' }
    if (looksSecret(body)) return { kind: 'skipped', reason: 'lesson looked like it held a credential' }
    assertTreeHasNoGraderVerdicts({ 'lesson.md': body })
    const taken = new Set(notes.paths(root))
    const base = `${LESSONS_FOLDER}/${slug(experience.cue)}`
    let path = base
    for (let n = 2; taken.has(path); n++) path = `${base}-${n}`
    notes.write(root, path, body, { actor: REFLECTION_TRIGGER, reason: `Lesson from run ${runId}` })
    return { kind: 'written', path }
  }
}
