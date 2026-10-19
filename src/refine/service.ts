// Refinements as the harness offers them: start one in the background, follow it, stop it, read
// what it produced, and adopt its chosen harness. The method itself is in `runner.ts`.
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { Bus } from '../core/bus'
import { HarnessError, invalid, notFound } from '../core/errors'
import { readJsonOr, safeId } from '../core/fs'
import * as store from '../tree/store'
import { PI_SURFACE } from '../tree/surface'
import { diffSummary, readTree, type TreeDiff } from '../tree/tree'
import type { TreeTrust } from '../tree/trust'
import { DEFAULT_REFINE_HOST, type RefineHost } from './host'
import { Library, libraryAreas, libraryScopes } from './library'
import { PiExecutor, PiImprover, type ImproverSettings, type RefineRuntime } from './pi'
import { checkWorkPrompts } from './prompts'
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
  id?: string
}

export interface CandidateView {
  label: string
  kind: 'base' | 'candidate' | 'final'
  ok: boolean
  delivered: boolean
  runId: string
  fingerprint: string | null
  diff: TreeDiff | null
  files: string[]
}

export interface RefinementsOptions {
  root: () => string
  bus: Bus
  runtime: RefineRuntime
  host: () => RefineHost | null
  trust: TreeTrust
  /** Replace the Pi executor and improver, for tests and the demo. */
  executor?: (id: string, dir: string, signal: AbortSignal) => Executor
  improver?: (id: string, dir: string, settings: ImproverSettings, signal: AbortSignal) => Improver
}

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
    const k = input.k ?? 1
    const mode = input.mode ?? 'parallel'
    if (mode !== 'parallel' && mode !== 'sequential') throw invalid('mode is parallel or sequential.')
    const base = input.baseVersion ? { tree: store.readVersion(root, task.scope, input.baseVersion) } : store.headTree(root, task.scope)
    if (!base) throw new HarnessError('harness_missing', `The harness '${task.scope}' has no version yet.`, 'Create or seed it first.')
    const id = input.id ? safeId(input.id) : `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`
    if (this.active.has(id)) throw invalid('That refinement is already running.')
    const dir = refineDir(root, id)
    const controller = new AbortController()
    const host = this.options.host() ?? DEFAULT_REFINE_HOST
    const executor = this.options.executor?.(id, dir, controller.signal) ?? new PiExecutor(this.options.runtime, host, id, dir, controller.signal)
    const improver = this.options.improver?.(id, dir, input.improver ?? {}, controller.signal) ?? new PiImprover(this.options.runtime, dir, input.improver ?? {}, controller.signal)
    const emit = (event: RefineEvent) => {
      if (event.type === 'summary') this.options.bus.emit({ type: 'refine.changed', id, scope: task.scope, status: event.summary.status })
      else this.options.bus.emit({ type: 'refine.event', id, scope: task.scope, event })
    }
    const done = runRefinement({ root, id, task, k, mode, executor, improver, baseTree: base.tree, onEvent: emit, signal: controller.signal })
      .catch((error) => {
        this.options.bus.emit({ type: 'refine.changed', id, scope: task.scope, status: 'failed', error: error instanceof Error ? error.message : String(error) })
        return null
      })
      .finally(() => this.active.delete(id))
    this.active.set(id, { controller, done })
    return { id }
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

  /** Every execution of a refinement: what harness it ran, how it differs from the base, what it produced. */
  candidates(id: string): CandidateView[] {
    const root = this.options.root()
    const summary = this.get(id)
    const dir = refineDir(root, id)
    const baseTree = readTree(PI_SURFACE, join(dir, 'harnesses', 'base'))
    const finals = new Set(summary.recursion?.finals ?? [])
    const labels = existsSync(join(dir, 'rollouts')) ? readdirSync(join(dir, 'rollouts')).sort() : []
    return labels.map((label) => {
      const record = readJsonOr<{ status?: string; files?: string[] }>(join(dir, 'rollouts', label, 'rollout.json'), {})
      const base = summary.base.find((entry) => entry.label === label)
      const harnessDir = join(dir, 'harnesses', label)
      const tree = existsSync(harnessDir) ? readTree(PI_SURFACE, harnessDir) : null
      const files = record.files ?? []
      return {
        label,
        kind: label.startsWith('base') ? 'base' : finals.has(label) ? 'final' : 'candidate',
        ok: base ? base.ok : record.status ? record.status === 'completed' : true,
        delivered: base ? base.delivered : files.length > 0,
        runId: `${id}-${label}`,
        fingerprint: tree ? store.fingerprint(tree) : null,
        diff: tree && !label.startsWith('base') ? diffSummary(PI_SURFACE, baseTree, tree) : null,
        files
      } satisfies CandidateView
    })
  }

  /**
   * Makes a refinement's chosen harness (or one of its candidates, by label) the scope's head.
   * Plugin code in it must already be trusted.
   */
  adopt(id: string, options: { label?: string | null } = {}): store.Head {
    const root = this.options.root()
    const summary = this.get(id)
    const label = options.label ?? summary.selection?.chosenLabel
    if (!label) throw invalid('This refinement has nothing to adopt.')
    const tree = readTree(PI_SURFACE, join(refineDir(root, id), 'harnesses', safeId(label)))
    if (!Object.keys(tree).length) throw notFound('That candidate harness')
    const untrusted = this.options.trust.review(tree).filter((plugin) => !plugin.trusted)
    if (untrusted.length) throw new HarnessError('plugin_untrusted', `Trust the plugin code first: ${untrusted.map((plugin) => plugin.path).join(', ')}.`, 'Review the plugin files on the Harness page, trust them, then adopt.')
    store.commit(root, summary.scope, tree, { kind: 'refinement', refineId: id, label, note: summary.selection?.why?.slice(0, 500) })
    this.options.bus.emit({ type: 'harnesses.changed', scope: summary.scope })
    return store.head(root, summary.scope)!
  }

  library(scope: string): { area: string; entries: ReturnType<Library['list']> }[] {
    const root = this.options.root()
    return libraryAreas(root, scope).map((area) => ({ area, entries: new Library(root, scope, area).list() }))
  }

  libraryEntry(scope: string, area: string, task: string): { experience: string | null; tree: Record<string, string> } {
    const library = new Library(this.options.root(), scope, area)
    return { experience: library.experienceText(task), tree: library.treeOf(task) }
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
