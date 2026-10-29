// `/variant` and `/refine` in the terminal (PROP-0052). Every change goes through the session's
// protected `terminal.variant.*` and `terminal.refine.*` calls; this module only asks and shows.
// A change to the head switches this conversation to it at the next turn boundary: the frontend
// restarts on that version and resumes the same conversation (ADR-0065).
import type { AgentSession, ExtensionUIContext } from '@earendil-works/pi-coding-agent'

export interface VariantCommandHost {
  session(): AgentSession
  control: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
  ui: ExtensionUIContext
  /** Shows read-only text in a scrollable page. */
  showText(title: string, text: string): Promise<void>
  /** Ends this frontend; its owner restarts it on the requested version. */
  shutdown(): void
}

interface VersionEntry {
  fingerprint: string
  parent: string | null
  source: { kind: string; note?: string; label?: string; components?: string[] }
  createdAt: string
  tags: string[]
  tunedFor?: { model: string } | null
}

interface FileDiff { path: string; before: string | null; after: string | null }

interface RefineSummaryView {
  id: string
  status: string
  startedAt: string
  endedAt: string | null
  usd: number
  errors: string[]
  guidance?: string | null
  chosenIsBase: boolean
  selection: { chosenLabel: string; why: string } | null
  recursion: { ledger?: { R: number; P: number; expectedR: number; expectedP: number } } | null
  running?: boolean
  mine?: boolean
}

interface CandidateView {
  label: string
  kind: 'base' | 'candidate' | 'final'
  ok: boolean
  delivered: boolean
  fingerprint: string | null
  diff: { added: string[]; removed: string[]; modified: string[] } | null
}

const short = (fp: string | null | undefined): string => (fp ? fp.slice(0, 8) : '—')

function modelOf(session: AgentSession): string | null {
  const model = session.model
  return model ? `${model.provider}/${model.id}` : null
}

/** A plain line diff for showing a variant change; small files get a real alignment. */
export function lineDiff(before: string, after: string): string[] {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length * b.length > 400_000) return [...a.map((line) => `- ${line}`), ...b.map((line) => `+ ${line}`)]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++ }
    else if (j < b.length && (i >= a.length || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) { out.push(`+ ${b[j]}`); j++ }
    else { out.push(`- ${a[i]}`); i++ }
  }
  return out
}

/** Renders file diffs as text, keeping three lines of context around each change. */
export function renderDiffs(files: readonly FileDiff[]): string {
  if (!files.length) return 'No differences.'
  const parts: string[] = []
  for (const file of files) {
    const status = file.before === null ? 'added' : file.after === null ? 'removed' : 'changed'
    parts.push(`━━ ${file.path} (${status})`)
    const lines = lineDiff(file.before ?? '', file.after ?? '')
    const keep = new Set<number>()
    lines.forEach((line, index) => { if (!line.startsWith('  ')) for (let k = index - 3; k <= index + 3; k++) keep.add(k) })
    let skipped = false
    lines.forEach((line, index) => {
      if (keep.has(index)) { parts.push(line); skipped = false } else if (!skipped) { parts.push('  …'); skipped = true }
    })
    parts.push('')
  }
  return parts.join('\n')
}

function describeVersion(entry: VersionEntry, head: string | null, pinned: string | null): string {
  const marks = [entry.fingerprint === pinned ? 'this chat' : '', entry.fingerprint === head ? 'head' : ''].filter(Boolean)
  const tags = entry.tags.length ? ` [${entry.tags.join(', ')}]` : ''
  const source = entry.source.kind === 'refinement' ? `refinement ${entry.source.label ?? ''}`.trim() : entry.source.kind
  const note = entry.source.note ? ` · ${entry.source.note.replace(/\s+/g, ' ').slice(0, 60)}` : ''
  return `${short(entry.fingerprint)}${tags} · ${source} · ${entry.createdAt.slice(0, 16).replace('T', ' ')}${marks.length ? ` · ${marks.join(', ')}` : ''}${note}`
}

/** Splits `--k 2 --mode sequential --model x --executor-model y rest` into options and the rest. */
export function parseRefineArguments(argument: string): { k?: number; mode?: 'parallel' | 'sequential'; improverModel?: string; executorModel?: string; guidance: string } {
  const out: ReturnType<typeof parseRefineArguments> = { guidance: '' }
  let rest = argument.trim()
  for (;;) {
    const match = /^--(k|mode|model|executor-model)\s+(\S+)\s*/.exec(rest)
    if (!match) break
    rest = rest.slice(match[0].length)
    const [, flag, value] = match
    if (flag === 'k') {
      const k = Number(value)
      if (!Number.isInteger(k) || k < 1 || k > 4) throw new Error('--k is a whole number from 1 to 4.')
      out.k = k
    } else if (flag === 'mode') {
      if (value !== 'parallel' && value !== 'sequential') throw new Error('--mode is parallel or sequential.')
      out.mode = value
    } else if (flag === 'model') out.improverModel = value
    else out.executorModel = value
  }
  out.guidance = rest.replace(/^["']([\s\S]*)["']$/, '$1').trim()
  return out
}

export function createVariantCommands(host: VariantCommandHost) {
  const notify = (text: string, level: 'info' | 'warning' | 'error' = 'info') => host.ui.notify(text, level)
  const watching = new Map<string, ReturnType<typeof setInterval>>()

  /** Restarts this conversation on `version` once no reply is running. */
  async function switchTo(version: string): Promise<void> {
    const session = host.session()
    if (!session.isIdle) {
      notify('This conversation switches variant when the current reply ends.')
      await session.waitForIdle()
    }
    const state = await host.control<{ pinned: string | null }>('terminal.variant.state')
    const result = await host.control<{ version: string; switching: boolean; record?: { tunedFor?: { model: string } | null } }>('terminal.variant.switch', { version })
    if (!result.switching) { notify(`This conversation already runs ${short(version)}.`); return }
    const tuned = result.record?.tunedFor?.model
    const current = modelOf(session)
    if (tuned && current && tuned !== current) notify(`Version ${short(version)} was tuned on ${tuned}; this chat uses ${current}.`, 'warning')
    notify(`Variant ${short(state.pinned)} → ${short(version)}${tuned ? ` · tuned for ${tuned}` : ''} · the prompt cache starts over. Resuming this conversation…`)
    host.shutdown()
  }

  async function chooseVersion(title: string): Promise<VersionEntry | undefined> {
    const lineage = await host.control<{ entries: VersionEntry[]; head: string | null; pinned: string | null }>('terminal.variant.lineage')
    if (!lineage.entries.length) { notify('This variant has no saved versions yet.'); return undefined }
    const labels = lineage.entries.map((entry) => describeVersion(entry, lineage.head, lineage.pinned))
    const picked = await host.ui.select(title, labels)
    return picked === undefined ? undefined : lineage.entries[labels.indexOf(picked)]
  }

  async function showCompare(from: string, to = 'head'): Promise<void> {
    const result = await host.control<{ from: string; to: string; files: FileDiff[] }>('terminal.variant.compare', { from, to })
    await host.showText(`Variant ${short(result.from)} → ${short(result.to)}`, renderDiffs(result.files))
  }

  async function revertFrom(from: string, selectors?: string[]): Promise<void> {
    let components = selectors
    if (!components?.length) {
      const typed = await host.ui.input('Components to take from this version', 'c4 skills/review plugins/guard.ts')
      components = (typed ?? '').split(/[\s,]+/).filter(Boolean)
      if (!components.length) return
    }
    const record = await host.control<{ fingerprint: string }>('terminal.variant.revert', { from, components })
    notify(`Saved ${short(record.fingerprint)}: ${components.join(', ')} from ${short(from)}.`)
    await switchTo(record.fingerprint)
  }

  async function versionMenu(entry: VersionEntry): Promise<void> {
    const actions = ['Switch this conversation to it', 'Restore it as the head', 'Compare with the head', 'Tag it…', 'Take some components from it…', ...entry.tags.map((tag) => `Remove tag ${tag}`)]
    const action = await host.ui.select(describeVersion(entry, null, null), actions)
    if (!action) return
    if (action === actions[0]) await switchTo(entry.fingerprint)
    else if (action === actions[1]) {
      await host.control('terminal.variant.restore', { version: entry.fingerprint })
      notify(`The head is ${short(entry.fingerprint)} again.`)
      await switchTo(entry.fingerprint)
    } else if (action === actions[2]) await showCompare(entry.fingerprint)
    else if (action === actions[3]) {
      const name = await host.ui.input('Tag name', 'good-for-ts')
      if (name?.trim()) {
        await host.control('terminal.variant.tag', { name: name.trim(), version: entry.fingerprint })
        notify(`Tagged ${short(entry.fingerprint)} as ${name.trim()}.`)
      }
    } else if (action === actions[4]) await revertFrom(entry.fingerprint)
    else {
      const tag = action.slice('Remove tag '.length)
      await host.control('terminal.variant.untag', { name: tag })
      notify(`Removed tag ${tag}.`)
    }
  }

  /** `/variant [use|restore|tag|untag|diff|revert] …` */
  async function variant(argument: string): Promise<void> {
    const [verb = '', ...rest] = argument.split(/\s+/).filter(Boolean)
    switch (verb) {
      case '': {
        const entry = await chooseVersion('Variant versions')
        if (entry) await versionMenu(entry)
        return
      }
      case 'use':
      case 'switch': {
        const { fingerprint } = await host.control<{ fingerprint: string }>('terminal.variant.resolve', { ref: rest[0] ?? 'head' })
        await switchTo(fingerprint)
        return
      }
      case 'restore': {
        if (!rest[0]) throw new Error('Use /variant restore <version or tag>.')
        const head = await host.control<{ fingerprint: string }>('terminal.variant.restore', { version: rest[0] })
        notify(`The head is ${short(head.fingerprint)} again.`)
        await switchTo(head.fingerprint)
        return
      }
      case 'tag': {
        if (!rest[0]) throw new Error('Use /variant tag <name> [version].')
        await host.control('terminal.variant.tag', { name: rest[0], version: rest[1] ?? 'head' })
        notify(`Tagged ${rest[1] ?? 'the head'} as ${rest[0]}.`)
        return
      }
      case 'untag': {
        if (!rest[0]) throw new Error('Use /variant untag <name>.')
        await host.control('terminal.variant.untag', { name: rest[0] })
        notify(`Removed tag ${rest[0]}.`)
        return
      }
      case 'diff':
      case 'compare': {
        if (!rest[0]) throw new Error('Use /variant diff <version or tag> [other].')
        await showCompare(rest[0], rest[1] ?? 'head')
        return
      }
      case 'revert': {
        if (!rest[0]) throw new Error('Use /variant revert <version or tag> <component…>, e.g. /variant revert good c4 skills/review.')
        const { fingerprint } = await host.control<{ fingerprint: string }>('terminal.variant.resolve', { ref: rest[0] })
        await revertFrom(fingerprint, rest.slice(1))
        return
      }
      default:
        throw new Error('Use /variant, or /variant use|restore|tag|untag|diff|revert ….')
    }
  }

  function watch(id: string): void {
    if (watching.has(id)) return
    const started = Date.now()
    const timer = setInterval(() => {
      void host.control<RefineSummaryView>('terminal.refine.get', { id }).then((summary) => {
        if (summary.status === 'running') {
          host.ui.setStatus('refine', `refine ${Math.round((Date.now() - started) / 60_000)}m`)
          return
        }
        clearInterval(timer)
        watching.delete(id)
        host.ui.setStatus('refine', undefined)
        if (summary.status === 'ok') notify(`Refinement ready${summary.chosenIsBase ? ' (it kept the current variant)' : ''}: /refine review to compare and adopt. $${summary.usd.toFixed(2)}`)
        else notify(`Refinement ${summary.status}${summary.errors[0] ? `: ${summary.errors[0]}` : ''}.`, 'warning')
      }).catch(() => {})
    }, 5_000)
    timer.unref?.()
    watching.set(id, timer)
    host.ui.setStatus('refine', 'refine 0m')
  }

  async function startRefinement(argument: string): Promise<void> {
    const options = parseRefineArguments(argument)
    const k = options.k ?? 1
    const mode = options.mode ?? 'parallel'
    const prepared = await host.control<{ task: { prompt: string; guidance?: string | null; workspace?: { commit: string } }; run: { startedAt: string; model: string | null }; notes: string[] }>('terminal.refine.prepare', { guidance: options.guidance })
    const executorModel = options.executorModel ?? modelOf(host.session()) ?? prepared.run.model
    const request = prepared.task.prompt.replace(/\s+/g, ' ')
    const message = [
      `Replays: ${request.length > 240 ? `${request.slice(0, 240)}…` : request}`,
      `From: the folder as that request found it (${prepared.run.startedAt.slice(0, 16).replace('T', ' ')}, snapshot ${short(prepared.task.workspace?.commit)})`,
      `Focus: ${prepared.task.guidance || 'none — improvers read every trajectory'}`,
      `Cost: ${4 * k} task runs + ${3 * k} improver sessions + selection and reflection (k=${k}, ${mode})`,
      `Task runs use: ${executorModel ?? 'the account default'} · improvers use: ${options.improverModel ?? 'the account default'}`,
      ...prepared.notes,
      '',
      'It runs in the background in throwaway copies. Nothing changes until you adopt a result.'
    ].join('\n')
    if (!await host.ui.confirm('Refine this variant?', message)) return
    const started = await host.control<{ id: string }>('terminal.refine.start', { guidance: options.guidance, k, mode, executorModel, improverModel: options.improverModel ?? null })
    notify(`Refinement ${started.id} started. Keep working; /refine status shows it.`)
    watch(started.id)
  }

  async function latest(argument: string, predicate: (summary: RefineSummaryView) => boolean): Promise<RefineSummaryView | undefined> {
    if (argument) return host.control<RefineSummaryView>('terminal.refine.get', { id: argument })
    const { refinements } = await host.control<{ refinements: RefineSummaryView[] }>('terminal.refine.list')
    return refinements.find(predicate)
  }

  async function review(argument: string): Promise<void> {
    const summary = await latest(argument, (entry) => entry.status === 'ok')
    if (!summary) { notify('No finished refinement to review yet.'); return }
    const candidates = await host.control<CandidateView[]>('terminal.refine.candidates', { id: summary.id })
    const chosen = summary.selection?.chosenLabel ?? null
    for (;;) {
      const rows = candidates.filter((entry) => entry.kind !== 'base' || entry.label === chosen)
      const labels = rows.map((entry) => {
        const changed = entry.diff ? [...entry.diff.added.map((p) => `+${p}`), ...entry.diff.removed.map((p) => `-${p}`), ...entry.diff.modified.map((p) => `~${p}`)] : []
        return `${entry.label === chosen ? '★ ' : '  '}${entry.label} · ${entry.kind}${entry.delivered ? '' : ' · no output'}${entry.ok ? '' : ' · failed'} · ${changed.length ? changed.slice(0, 4).join(' ') + (changed.length > 4 ? ` +${changed.length - 4}` : '') : 'unchanged'}`
      })
      const header = `Refinement ${summary.id}${summary.guidance ? ` · focus: ${summary.guidance.slice(0, 50)}` : ''} · ★ selector's pick`
      const picked = await host.ui.select(header, labels)
      if (picked === undefined) return
      const entry = rows[labels.indexOf(picked)]!
      const actions = ['View its changes', 'View what it produced', 'Adopt it and switch this chat', ...(entry.label === chosen && summary.selection?.why ? ["Why the selector chose it"] : [])]
      const action = await host.ui.select(entry.label, actions)
      if (!action) continue
      if (action === actions[0]) {
        const diff = await host.control<{ files: FileDiff[] }>('terminal.refine.diff', { id: summary.id, label: entry.label })
        await host.showText(`${entry.label}: changes from the base`, renderDiffs(diff.files))
      } else if (action === actions[1]) {
        const output = await host.control<Record<string, string>>('terminal.refine.output', { id: summary.id, label: entry.label })
        const text = Object.entries(output).map(([name, body]) => `━━ ${name}\n${body}`).join('\n\n')
        await host.showText(`${entry.label}: output`, text || 'It produced nothing.')
      } else if (action === actions[2]) {
        const tag = await host.ui.input('Tag for this version (optional)', '')
        const head = await host.control<{ fingerprint: string }>('terminal.refine.adopt', { id: summary.id, label: entry.label, tag: tag?.trim() || null })
        notify(`Adopted ${entry.label} as ${short(head.fingerprint)}${tag?.trim() ? ` [${tag.trim()}]` : ''}.`)
        await switchTo(head.fingerprint)
        return
      } else await host.showText('Why the selector chose it', summary.selection!.why)
    }
  }

  /** `/refine [--k N] [--mode m] [--model id] [--executor-model id] [guidance]`, or status|stop|review. */
  async function refine(argument: string): Promise<void> {
    const [verb = '', ...rest] = argument.split(/\s+/).filter(Boolean)
    const tail = rest.join(' ')
    if (verb === 'status') {
      const { refinements } = await host.control<{ refinements: RefineSummaryView[] }>('terminal.refine.list')
      if (!refinements.length) { notify('No refinements for this variant yet. /refine <what to look at> starts one.'); return }
      await host.showText('Refinements', refinements.map((entry) => `${entry.id} · ${entry.running ? 'running' : entry.status} · ${entry.startedAt.slice(0, 16).replace('T', ' ')} · $${entry.usd.toFixed(2)}${entry.selection ? ` · chose ${entry.selection.chosenLabel}` : ''}${entry.guidance ? `\n    focus: ${entry.guidance}` : ''}`).join('\n'))
      return
    }
    if (verb === 'stop') {
      const target = await latest(tail, (entry) => entry.running === true)
      if (!target) { notify('No refinement is running.'); return }
      await host.control('terminal.refine.stop', { id: target.id })
      notify(`Stopping refinement ${target.id}.`)
      return
    }
    if (verb === 'review') { await review(tail); return }
    await startRefinement(argument)
  }

  return { variant, refine }
}
