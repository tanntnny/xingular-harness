// Refinements as the harness offers them: start one in the background, follow it, stop it, read
// what it produced, and adopt its chosen harness. The method itself is in `runner.ts`.
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Bus } from '../core/bus'
import { HarnessError, invalid, notFound } from '../core/errors'
import { readJsonOr, safeId } from '../core/fs'
import { findRun, listRuns, readEvents } from '../sessions/runStore'
import type { RunRecord } from '../sessions/contracts'
import * as store from '../variant/store'
import { PI_SURFACE } from '../variant/surface'
import { diffSummary, readVariant, type VariantDiff } from '../variant/variant'
import type { VariantTrust } from '../variant/trust'
import { DEFAULT_REFINE_HOST, type RefineHost } from './host'
import { Library, libraryAreas, libraryScopes } from './library'
import { PiExecutor, PiImprover, RETAINED_WORKSPACE, type ImproverSettings, type RefineRuntime } from './pi'
import { checkGuidance, checkWorkPrompts } from './prompts'
import { readSummary, refineDir, runRefinement, type RefineEvent, type RefineSummary } from './runner'
import type { Executor, Improver, RecursionMode, RefineTask } from './types'

export interface StartInput {
  task: RefineTask
  k?: number
  mode?: RecursionMode
  /** The model and account improver, selector and reflector sessions use. Defaults to the account default. */
  improver?: ImproverSettings
  /** Start from this version of the scope instead of its head. */
  baseVersion?: string | null
  /** Model, effort and account for executions; a host's own session settings win (PROP-0003). */
  executor?: ImproverSettings
  /** Keep every execution's workspace under `rollouts/<label>/workspace/` for measurement afterwards. */
  retainWorkspaces?: boolean
  id?: string
}

export interface CandidateView {
  label: string
  kind: 'base' | 'candidate' | 'final'
  ok: boolean
  delivered: boolean
  runId: string
  fingerprint: string | null
  diff: VariantDiff | null
  files: string[]
  /** The retained workspace of this execution, or null when the refinement did not keep it. */
  workspace: string | null
}

/** A refinement task made from a recorded turn, and what the person should know before starting it. */
export interface TaskFromRun {
  task: RefineTask
  /** The turn it replays. */
  run: { id: string; sessionId: string; startedAt: string; model: string | null }
  /** Things the replay leaves out, such as attached images. */
  notes: string[]
}

/** The text the person typed for a turn: its first user message, else its recorded goal. */
function requestOf(root: string, record: RunRecord): string {
  try {
    for (const event of readEvents(root, record.id)) {
      const payload = event.payload as { role?: string; text?: string } | undefined
      if (event.type === 'message.completed' && payload?.role === 'user' && typeof payload.text === 'string' && payload.text.trim()) return payload.text
    }
  } catch {
    // Fall back to the goal.
  }
  return record.goal ?? ''
}

/** A run a person typed, at the top of its session: what `/refine` may replay. */
function replayable(record: RunRecord): boolean {
  return (record.trigger == null || record.trigger === 'user') && !record.relation && !record.parentRunId
}

export interface RefinementsOptions {
  root: () => string
  bus: Bus
  runtime: RefineRuntime
  host: () => RefineHost | null
  trust: VariantTrust
  /** Replace the Pi executor and improver, for tests and the demo. */
  executor?: (id: string, dir: string, signal: AbortSignal) => Executor
  improver?: (id: string, dir: string, settings: ImproverSettings, signal: AbortSignal) => Improver
}

function checkGuidanceOrInvalid(guidance: string): string {
  try {
    return checkGuidance(guidance)
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error))
  }
}

/** A refinement's variants folder; records made before PROP-0009 call it `harnesses`. */
const variantsFolder = (dir: string): string => (existsSync(join(dir, 'variants')) || !existsSync(join(dir, 'harnesses')) ? join(dir, 'variants') : join(dir, 'harnesses'))

export class Refinements {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<RefineSummary | null> }>()

  constructor(private readonly options: RefinementsOptions) {}

  /** Starts a refinement and returns at once; progress arrives as `refine.changed` and `refine.event` notices. */
  start(input: StartInput): { id: string } {
    const root = this.options.root()
    const task = input.task
    if (!task || typeof task.id !== 'string' || !task.id.trim() || typeof task.prompt !== 'string' || !task.prompt.trim()) throw invalid('A refinement needs a task with an id and a request.')
    safeId(task.scope)
    if (task.prompts) checkWorkPrompts(task.prompts)
    if (task.guidance != null) {
      if (typeof task.guidance !== 'string') throw invalid('guidance is text.')
      task.guidance = checkGuidanceOrInvalid(task.guidance) || null
    }
    if (task.workspace != null && (task.workspace.kind !== 'git-snapshot' || typeof task.workspace.repo !== 'string' || !/^[0-9a-f]{40,64}$/.test(String(task.workspace.commit)))) throw invalid('workspace is a git snapshot: { kind: "git-snapshot", repo, commit }.')
    const k = input.k ?? 1
    const mode = input.mode ?? 'parallel'
    if (mode !== 'parallel' && mode !== 'sequential') throw invalid('mode is parallel or sequential.')
    const base = input.baseVersion ? { variant: store.readVersion(root, task.scope, input.baseVersion) } : store.headVariant(root, task.scope)
    if (!base) throw new HarnessError('harness_missing', `The harness '${task.scope}' has no version yet.`, 'Create or seed it first.')
    const id = input.id ? safeId(input.id) : `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`
    if (this.active.has(id)) throw invalid('That refinement is already running.')
    const dir = refineDir(root, id)
    const controller = new AbortController()
    const host = this.options.host() ?? DEFAULT_REFINE_HOST
    const executor = this.options.executor?.(id, dir, controller.signal) ?? new PiExecutor(this.options.runtime, host, id, dir, controller.signal, { retainWorkspaces: input.retainWorkspaces === true, settings: input.executor })
    const improver = this.options.improver?.(id, dir, input.improver ?? {}, controller.signal) ?? new PiImprover(this.options.runtime, dir, input.improver ?? {}, controller.signal)
    const emit = (event: RefineEvent) => {
      if (event.type === 'summary') this.options.bus.emit({ type: 'refine.changed', id, scope: task.scope, status: event.summary.status })
      else this.options.bus.emit({ type: 'refine.event', id, scope: task.scope, event })
    }
    const done = runRefinement({ root, id, task, k, mode, executor, improver, baseVariant: base.variant, settings: { executor: input.executor ?? null, improver: input.improver ?? null }, onEvent: emit, signal: controller.signal })
      .catch((error) => {
        this.options.bus.emit({ type: 'refine.changed', id, scope: task.scope, status: 'failed', error: error instanceof Error ? error.message : String(error) })
        return null
      })
      .finally(() => this.active.delete(id))
    this.active.set(id, { controller, done })
    return { id }
  }

  /**
   * A task that replays one recorded turn (`runId`) or the latest turn a person typed in a session
   * (`sessionId`), from the working tree as that turn found it. Refuses a turn with no snapshot.
   */
  taskFromRun(input: { runId?: string | null; sessionId?: string | null; nativeSessionId?: string | null; guidance?: string | null }): TaskFromRun {
    const root = this.options.root()
    let record: RunRecord | null = null
    const latest = (records: RunRecord[]) => records.find((entry) => replayable(entry) && requestOf(root, entry).trim()) ?? null
    if (input.runId) record = findRun(root, safeId(input.runId))
    else if (input.sessionId || input.nativeSessionId) {
      if (input.sessionId) record = latest(listRuns(root, { sessionId: input.sessionId }))
      // A terminal that restarted on another version keeps its conversation under a new session id.
      if (!record && input.nativeSessionId) record = latest(listRuns(root, {}).filter((entry) => entry.nativeSessionId === input.nativeSessionId))
    } else throw invalid('Name a run or a session to refine from.')
    if (!record) throw notFound(input.runId ? 'That run' : 'A request in this session')
    if (!replayable(record)) throw invalid('Only a request a person typed can be replayed; this run was started by something else.')
    const prompt = requestOf(root, record).trim()
    if (!prompt) throw invalid('That run has no request text to replay.')
    if (!record.variantScope) throw invalid('That run used no variant, so there is nothing to refine.')
    const snapshot = record.workspaceSnapshot
    if (!snapshot) throw new HarnessError('replay_unavailable', 'That request has no snapshot of the folder it started in, so it cannot be replayed safely.', 'Refinement replays requests made in a git repository; the snapshot is skipped outside git or when it takes over two seconds.')
    const notes: string[] = []
    if (snapshot.omitted) notes.push(`${snapshot.omitted} untracked file${snapshot.omitted === 1 ? ' was' : 's were'} too large or too many to snapshot and will be missing from the replay.`)
    if (record.attachmentCount > 0) notes.push(`${record.attachmentCount} attachment${record.attachmentCount === 1 ? '' : 's'} on that request are not replayed; only its text is.`)
    const guidance = input.guidance?.trim() ? checkGuidanceOrInvalid(input.guidance) : null
    return {
      task: { id: `turn-${record.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12)}`, scope: record.variantScope, prompt, workspace: snapshot, ...(guidance ? { guidance } : {}) },
      run: { id: record.id, sessionId: record.sessionId, startedAt: record.startedAt, model: record.model ?? null },
      notes
    }
  }

  /** Waits for a running refinement; resolves at once for one that is not running. */
  async wait(id: string): Promise<RefineSummary | null> {
    return (await this.active.get(id)?.done) ?? readSummary(this.options.root(), id)
  }

  get(id: string): RefineSummary {
    const summary = readSummary(this.options.root(), safeId(id))
    if (!summary) throw notFound('That refinement')
    return summary
  }

  running(): string[] {
    return [...this.active.keys()]
  }

  /** Every recorded refinement, newest first, optionally for one scope. */
  list(options: { scope?: string | null; limit?: number } = {}): RefineSummary[] {
    const dir = join(this.options.root(), 'refine')
    if (!existsSync(dir)) return []
    const out: RefineSummary[] = []
    for (const name of readdirSync(dir).sort().reverse()) {
      if (name === 'library') continue
      const summary = readSummary(this.options.root(), name)
      if (summary && (!options.scope || summary.scope === options.scope)) out.push(summary)
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, options.limit ?? 100)
  }

  async cancel(id: string): Promise<void> {
    const running = this.active.get(id)
    if (!running) return
    running.controller.abort()
    await running.done
  }

  /** Every execution of a refinement: what variant it ran, how it differs from the base, what it produced. */
  candidates(id: string): CandidateView[] {
    const root = this.options.root()
    const summary = this.get(id)
    const dir = refineDir(root, id)
    const baseVariant = readVariant(PI_SURFACE, join(variantsFolder(dir), 'base'))
    const finals = new Set(summary.recursion?.finals ?? [])
    const labels = existsSync(join(dir, 'rollouts')) ? readdirSync(join(dir, 'rollouts')).sort() : []
    return labels.map((label) => {
      const record = readJsonOr<{ status?: string; files?: string[] }>(join(dir, 'rollouts', label, 'rollout.json'), {})
      const base = summary.base.find((entry) => entry.label === label)
      const variantDir = join(variantsFolder(dir), label)
      const variant = existsSync(variantDir) ? readVariant(PI_SURFACE, variantDir) : null
      const files = record.files ?? []
      const workspace = join(dir, 'rollouts', label, RETAINED_WORKSPACE)
      return {
        label,
        kind: label.startsWith('base') ? 'base' : finals.has(label) ? 'final' : 'candidate',
        ok: base ? base.ok : record.status ? record.status === 'completed' : true,
        delivered: base ? base.delivered : files.length > 0,
        runId: `${id}-${label}`,
        fingerprint: variant ? store.fingerprint(variant) : null,
        diff: variant && !label.startsWith('base') ? diffSummary(PI_SURFACE, baseVariant, variant) : null,
        files,
        workspace: existsSync(workspace) ? workspace : null
      } satisfies CandidateView
    })
  }

  /** File by file, how one candidate's variant differs from the refinement's base. */
  candidateDiff(id: string, label: string): { label: string; files: store.FileDiff[] } {
    this.get(id)
    const dir = variantsFolder(refineDir(this.options.root(), id))
    const base = readVariant(PI_SURFACE, join(dir, 'base'))
    const candidateDir = join(dir, safeId(label))
    if (!existsSync(candidateDir)) throw notFound('That candidate variant')
    const after = readVariant(PI_SURFACE, candidateDir)
    const summary = diffSummary(PI_SURFACE, base, after)
    const files = [...summary.added, ...summary.removed, ...summary.modified].sort().map((path) => ({ path, before: base[path] ?? null, after: after[path] ?? null }))
    return { label, files }
  }

  /** What one execution produced, filename → text. */
  candidateOutput(id: string, label: string): Record<string, string> {
    this.get(id)
    const dir = join(refineDir(this.options.root(), id), 'rollouts', safeId(label))
    if (!existsSync(dir)) throw notFound('That execution')
    const record = readJsonOr<{ files?: string[] }>(join(dir, 'rollout.json'), {})
    const out: Record<string, string> = {}
    for (const name of record.files ?? []) {
      try {
        out[name] = readFileSync(join(dir, 'deliverables', name), 'utf8')
      } catch {
        // A file that went missing is not shown.
      }
    }
    return out
  }

  /**
   * Makes a refinement's chosen harness (or one of its candidates, by label) the scope's head.
   * Plugin code in it must already be trusted.
   */
  adopt(id: string, options: { label?: string | null; tag?: string | null } = {}): store.Head {
    const root = this.options.root()
    const summary = this.get(id)
    const label = options.label ?? summary.selection?.chosenLabel
    if (!label) throw invalid('This refinement has nothing to adopt.')
    const variant = readVariant(PI_SURFACE, join(variantsFolder(refineDir(root, id)), safeId(label)))
    if (!Object.keys(variant).length) throw notFound('That candidate variant')
    if (options.tag) store.checkTagName(options.tag)
    const untrusted = this.options.trust.review(variant).filter((plugin) => !plugin.trusted)
    if (untrusted.length) throw new HarnessError('plugin_untrusted', `Trust the plugin code first: ${untrusted.map((plugin) => plugin.path).join(', ')}.`, 'Review the plugin files on the Harness page, trust them, then adopt.')
    // The model the adopted variant was tuned on: what its own execution resolved, else what the refinement asked for.
    const model = findRun(root, `${id}-${label}`)?.model ?? summary.settings?.executor?.model ?? null
    store.commit(root, summary.scope, variant, { kind: 'refinement', refineId: id, label, note: summary.selection?.why?.slice(0, 500) }, { tunedFor: model ? { model } : null })
    const adopted = store.head(root, summary.scope)!
    if (options.tag) store.tag(root, summary.scope, options.tag, adopted.fingerprint)
    this.options.bus.emit({ type: 'variants.changed', scope: summary.scope })
    return adopted
  }

  library(scope: string): { area: string; entries: ReturnType<Library['list']> }[] {
    const root = this.options.root()
    return libraryAreas(root, scope).map((area) => ({ area, entries: new Library(root, scope, area).list() }))
  }

  libraryEntry(scope: string, area: string, task: string): { experience: string | null; variant: Record<string, string> } {
    const library = new Library(this.options.root(), scope, area)
    return { experience: library.experienceText(task), variant: library.variantOf(task) }
  }

  forget(scope: string, area: string, tasks: string[]): void {
    new Library(this.options.root(), scope, area).forget(tasks)
    this.options.bus.emit({ type: 'library.changed', scope })
  }

  scopes(): string[] {
    return libraryScopes(this.options.root())
  }

  async close(): Promise<void> {
    for (const id of this.running()) await this.cancel(id)
  }
}
