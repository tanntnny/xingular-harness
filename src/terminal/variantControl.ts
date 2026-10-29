// `/variant` and `/refine` for a terminal session: its variant's versions (lineage, compare,
// restore, tags, per-component revert, switching this conversation to another version) and
// refinements that replay the latest request a person typed here (PROP-0052). The calls arrive
// with the session's control key; everything they change goes through the variant store's
// validated door and the refinement service.
import { HarnessError, invalid } from '../core/errors'
import type { Bus } from '../core/bus'
import type { Refinements } from '../refine/service'
import { readSummary } from '../refine/runner'
import * as store from '../variant/store'

export interface VariantControlContext {
  root: string
  bus: Bus
  sessionId: string
  /** The native conversation, which outlives a restart on another version. */
  nativeSessionId: string | null
  /** The scope this session runs, or null for a directory-backed or absent variant. */
  scope: string | null
  /** The version this conversation runs now. */
  pinned: string | null
  /** Whether a reply is running; a switch waits for it. */
  active(): boolean
  /** Asks the frontend's owner to restart this conversation on another version. */
  relaunchOn(version: string): void
  refine: Refinements | null
  /** Refinements this session started, newest last. */
  started: string[]
}

function textParam(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${key} is required.`)
  return value.trim()
}

function writableScope(ctx: VariantControlContext): string {
  if (!ctx.scope) throw invalid('This terminal runs a variant folder, not a saved scope, so it has no versions to change.')
  return ctx.scope
}

/** One `terminal.variant.*` call. */
export function variantCall(ctx: VariantControlContext, call: string, params: Record<string, unknown>): unknown {
  const { root } = ctx
  const action = call.slice('terminal.variant.'.length)
  if (action === 'state') {
    if (!ctx.scope) return { scope: null, pinned: ctx.pinned, head: null, tags: {}, pinnedRecord: null }
    return {
      scope: ctx.scope,
      pinned: ctx.pinned,
      head: store.head(root, ctx.scope)?.fingerprint ?? null,
      tags: store.tags(root, ctx.scope),
      pinnedRecord: ctx.pinned ? store.versionRecord(root, ctx.scope, ctx.pinned) : null
    }
  }
  const scope = writableScope(ctx)
  const changed = () => ctx.bus.emit({ type: 'variants.changed', scope })
  switch (action) {
    case 'lineage':
      return { entries: store.lineage(root, scope), head: store.head(root, scope)?.fingerprint ?? null, pinned: ctx.pinned }
    case 'resolve': {
      const fingerprint = store.resolveRef(root, scope, textParam(params, 'ref'))
      return { fingerprint, version: store.versionRecord(root, scope, fingerprint) }
    }
    case 'compare': {
      const from = store.resolveRef(root, scope, textParam(params, 'from'))
      const to = store.resolveRef(root, scope, typeof params.to === 'string' && params.to.trim() ? params.to.trim() : 'head')
      return { from, to, ...store.compare(root, scope, from, to) }
    }
    case 'restore': {
      const head = store.restore(root, scope, store.resolveRef(root, scope, textParam(params, 'version')), 'restored from the terminal')
      changed()
      return head
    }
    case 'tag': {
      const tags = store.tag(root, scope, textParam(params, 'name'), store.resolveRef(root, scope, typeof params.version === 'string' && params.version.trim() ? params.version.trim() : 'head'))
      changed()
      return tags
    }
    case 'untag': {
      const tags = store.untag(root, scope, textParam(params, 'name'))
      changed()
      return tags
    }
    case 'revert': {
      const from = store.resolveRef(root, scope, textParam(params, 'from'))
      const components = Array.isArray(params.components) ? params.components.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim()) : []
      const record = store.revertComponents(root, scope, from, components)
      changed()
      return record
    }
    case 'switch': {
      // The conversation restarts on that version at the next turn boundary; a run never changes variant (INV-RUN-1).
      const version = store.resolveRef(root, scope, typeof params.version === 'string' && params.version.trim() ? params.version.trim() : 'head')
      if (ctx.active()) throw new HarnessError('session_busy', 'A reply is still running; switch once it ends.')
      if (version === ctx.pinned) return { version, switching: false }
      ctx.relaunchOn(version)
      return { version, switching: true, record: store.versionRecord(root, scope, version) }
    }
    default:
      throw new HarnessError('unknown_method', `Unknown call ${call}.`)
  }
}

/** One `terminal.refine.*` call. */
export function refineCall(ctx: VariantControlContext, call: string, params: Record<string, unknown>): unknown {
  const refine = ctx.refine
  if (!refine) throw invalid('Refinement is unavailable in this host.')
  const action = call.slice('terminal.refine.'.length)
  const own = (id: string): string => {
    if (!ctx.started.includes(id) && !refine.list({ scope: ctx.scope }).some((summary) => summary.id === id)) throw invalid('That refinement is not one of this variant\'s.')
    return id
  }
  switch (action) {
    case 'prepare': {
      writableScope(ctx)
      const made = refine.taskFromRun({ sessionId: ctx.sessionId, nativeSessionId: ctx.nativeSessionId, guidance: typeof params.guidance === 'string' ? params.guidance : null })
      if (made.task.scope !== ctx.scope) throw invalid('The latest request ran on another variant; switch to it first.')
      return made
    }
    case 'start': {
      const scope = writableScope(ctx)
      const made = refine.taskFromRun({ sessionId: ctx.sessionId, nativeSessionId: ctx.nativeSessionId, guidance: typeof params.guidance === 'string' ? params.guidance : null })
      if (made.task.scope !== scope) throw invalid('The latest request ran on another variant; switch to it first.')
      const k = typeof params.k === 'number' && Number.isInteger(params.k) && params.k >= 1 && params.k <= 4 ? params.k : 1
      const mode = params.mode === 'sequential' ? 'sequential' : 'parallel'
      const model = (key: string): string | null => typeof params[key] === 'string' && (params[key] as string).trim() ? (params[key] as string).trim() : null
      const executorModel = model('executorModel') ?? made.run.model
      const improverModel = model('improverModel')
      const { id } = refine.start({
        task: made.task,
        k,
        mode,
        baseVersion: ctx.pinned,
        executor: executorModel ? { model: executorModel } : undefined,
        improver: improverModel ? { model: improverModel } : {}
      })
      ctx.started.push(id)
      return { id, task: made.task, run: made.run, notes: made.notes, k, mode, executorModel, improverModel }
    }
    case 'list': {
      const running = new Set(refine.running())
      return { refinements: refine.list({ scope: ctx.scope, limit: typeof params.limit === 'number' ? params.limit : 20 }).map((summary) => ({ ...summary, running: running.has(summary.id), mine: ctx.started.includes(summary.id) })) }
    }
    case 'get': return readSummary(ctx.root, own(textParam(params, 'id')))
    case 'stop': {
      const id = own(textParam(params, 'id'))
      void refine.cancel(id)
      return { id }
    }
    case 'candidates': return refine.candidates(own(textParam(params, 'id')))
    case 'diff': return refine.candidateDiff(own(textParam(params, 'id')), textParam(params, 'label'))
    case 'output': return refine.candidateOutput(own(textParam(params, 'id')), textParam(params, 'label'))
    case 'adopt': {
      const id = own(textParam(params, 'id'))
      return refine.adopt(id, { label: typeof params.label === 'string' && params.label ? params.label : null, tag: typeof params.tag === 'string' && params.tag.trim() ? params.tag.trim() : null })
    }
    default:
      throw new HarnessError('unknown_method', `Unknown call ${call}.`)
  }
}
