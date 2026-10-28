// Builds one run's context attribution from what the run recorded. Read-only: it opens the run's
// pack and its events, and never writes either.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { HarnessEnv } from '../core/env'
import { load, type ContextPack, type Section } from '../prompt/compile'
import type { RunEvent } from '../sessions/contracts'
import { readEvents } from '../sessions/runStore'
import { materialise } from '../variant/materialise'
import type { ContextAttribution, ContextCompaction, ContextGroup, ContextOnDemand, ContextPoint, ContextRow } from './types'

/** The house constant: four characters per token, the ratio Pi's own estimator uses. */
export const CHARS_PER_TOKEN = 4

/** Estimated tokens in a number of characters. */
export function tokensOf(chars: number): number {
  return Math.max(0, Math.ceil(chars / CHARS_PER_TOKEN))
}

interface Snapshot {
  systemPrompt?: string
  contextUpdate?: string
  tools?: { name: string; description: string; parameters: unknown }[]
  compaction?: { enabled: boolean; reserveTokens: number }
  systemPromptTruncated?: boolean
  contextUpdateTruncated?: boolean
  toolsTruncated?: boolean
}

interface Usage {
  contextTokens?: number
  contextWindow?: number
  model?: string
  provider?: string
  request?: { index?: number }
}

/** The harness's own tool groups: their schemas are the released half's cost, not the host's. */
const HARNESS_TOOL_GROUPS = new Set(['History', 'Wiki', 'Native', 'World', 'Progress', 'Session', 'Annotations'])

/** Sections the harness writes itself, when a pack was recorded without its delivery record. */
const FOUNDATION_SECTIONS = new Set(['harness-identity', 'tools', 'reporting'])
const DYNAMIC_SECTIONS = new Set(['wiki', 'session-state', 'references', 'required-skills'])

const GROUP_ORDER: readonly ContextGroup[] = ['foundation', 'variant', 'application', 'conversation', 'reserved']

function lastEvent<T>(events: readonly RunEvent[], type: string): T | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === type) return event.payload as T
  }
  return null
}

function sectionGroup(section: Section, dynamic: ReadonlySet<string>): ContextGroup {
  if (dynamic.has(section.id)) return 'conversation'
  if (section.sources.some((source) => source.kind === 'variant')) return 'variant'
  return FOUNDATION_SECTIONS.has(section.id) ? 'foundation' : 'application'
}

/** Characters one recorded tool's schema occupies: its name, description and parameter schema. */
function toolChars(tool: { name: string; description: string; parameters: unknown }): number {
  try {
    return JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length
  } catch {
    return tool.name.length + tool.description.length
  }
}

function shareOf(tokens: number, window: number | null): number | null {
  if (!window) return null
  return Math.max(0, Math.min(100, (tokens / window) * 100))
}

/** How many skills a variant folder offers, and roughly what one costs to load. */
function skillCost(paths: readonly string[]): { items: number; tokensEach: number } | null {
  const sizes: number[] = []
  for (const path of paths) {
    let entries: string[]
    try {
      entries = readdirSync(path)
    } catch {
      continue
    }
    for (const entry of entries) {
      try {
        const stat = statSync(join(path, entry, 'SKILL.md'))
        if (stat.isFile()) sizes.push(stat.size)
      } catch {
        // A skill without a readable SKILL.md is not counted.
      }
    }
  }
  if (!sizes.length) return null
  const average = sizes.reduce((sum, size) => sum + size, 0) / sizes.length
  return { items: sizes.length, tokensEach: tokensOf(average) }
}

/** What one variant component costs when it is loaded, read from the variant the run actually used. */
function onDemandOf(env: HarnessEnv, pack: ContextPack): ContextOnDemand[] {
  const scope = pack.variant?.scope
  if (!scope) return []
  let built: ReturnType<typeof materialise>
  try {
    built = materialise(env.root, { scope })
  } catch {
    return []
  }
  const rows: ContextOnDemand[] = []
  const skills = skillCost(built.skillPaths)
  if (skills) rows.push({ id: 'skills', title: 'Skills (c6)', items: skills.items, tokensEach: skills.tokensEach, note: 'loaded when a situation matches' })
  if (built.subagents.length) rows.push({ id: 'subagents', title: 'Subagents (c5)', items: built.subagents.length, tokensEach: null, note: 'each runs in its own context' })
  const scripts = Object.keys(built.files).filter((path) => path.startsWith('scripts/') && !path.endsWith('README.md'))
  if (scripts.length) rows.push({ id: 'scripts', title: 'Scripts (c7)', items: scripts.length, tokensEach: null, note: 'run, not read into context' })
  return rows
}

/**
 * One run's attribution, or null when the run recorded no pack. A run whose latest request the
 * provider measured is `measured`: its conversation row is the remainder, so the rows add up to the
 * figure the provider reported rather than to an estimate of their own.
 */
export function attribution(env: HarnessEnv, runId: string): ContextAttribution | null {
  const pack = load(env.root, runId)
  if (!pack) return null
  const events = readEvents(env.root, runId)
  const snapshot = lastEvent<Snapshot>(events, 'context.snapshot')
  const usage = lastEvent<Usage>(events, 'usage.updated')

  const sizes = pack.delivery?.sizes
  const updatedIds = pack.delivery?.updatedSectionIds ?? []
  const dynamic = pack.delivery
    ? new Set(updatedIds)
    : new Set([...DYNAMIC_SECTIONS].filter((id) => pack.sections.some((section) => section.id === id)))
  const stable = pack.sections.filter((section) => !dynamic.has(section.id))

  const window = typeof usage?.contextWindow === 'number' && usage.contextWindow > 0 ? usage.contextWindow : null
  const measuredTokens = typeof usage?.contextTokens === 'number' && usage.contextTokens > 0 ? usage.contextTokens : null
  let approximate = !sizes
  if (snapshot?.systemPromptTruncated || snapshot?.contextUpdateTruncated || snapshot?.toolsTruncated) approximate = true

  const rows: ContextRow[] = []

  for (const section of stable) {
    const chars = sizes?.system[section.id] ?? section.size
    // The tools section ends with the variant's tool guidance: count that part as the variant's.
    const variantChars = section.id === 'tools' ? Math.min(section.sources.find((source) => source.kind === 'variant')?.chars ?? 0, chars) : 0
    const own = Math.max(0, chars - variantChars)
    if (own > 0) {
      rows.push({
        id: section.id,
        title: section.title,
        group: sectionGroup(section, dynamic),
        tokens: tokensOf(own),
        chars: own,
        share: null,
        always: true,
        estimated: true,
        budget: section.budget,
        ...(section.cut ? { cut: true } : {}),
        ...(section.sources.length ? { sources: section.sources.map((source) => ({ ...source })) } : {})
      })
    }
    if (variantChars > 0) {
      rows.push({ id: 'tool-guidance', title: 'Tool guidance (c4)', group: 'variant', tokens: tokensOf(variantChars), chars: variantChars, share: null, always: true, estimated: true })
    }
  }

  const framing = sizes?.systemFraming ?? 0
  if (framing > 0) {
    rows.push({ id: 'framing', title: 'Prompt framing', group: 'foundation', tokens: tokensOf(framing), chars: framing, share: null, always: true, estimated: true, note: 'headings and the context-update guidance' })
  }

  // Tool schemas, by the owner of the tools: the harness's own groups against the application's.
  const groupOfTool = new Map<string, string>()
  for (const group of pack.toolGroups) for (const name of group.tools) groupOfTool.set(name, group.group)
  for (const [group, harnessOwned] of [['foundation', true], ['application', false]] as const) {
    const owned = (snapshot?.tools ?? []).filter((tool) => HARNESS_TOOL_GROUPS.has(groupOfTool.get(tool.name) ?? '') === harnessOwned)
    if (!owned.length) continue
    const chars = owned.reduce((sum, tool) => sum + toolChars(tool), 0)
    const byGroup = new Map<string, number>()
    for (const tool of owned) {
      const name = groupOfTool.get(tool.name) ?? 'Other tools'
      byGroup.set(name, (byGroup.get(name) ?? 0) + 1)
    }
    rows.push({
      id: harnessOwned ? 'tools-harness' : 'tools-application',
      title: `Tool schemas · ${owned.length} ${owned.length === 1 ? 'tool' : 'tools'}`,
      group,
      tokens: tokensOf(chars),
      chars,
      share: null,
      always: true,
      estimated: true,
      tools: [...byGroup].map(([name, count]) => ({ group: name, count }))
    })
  }

  // What arrived as this request's context update, and the messages it joined.
  for (const id of updatedIds) {
    const section = pack.sections.find((entry) => entry.id === id)
    if (!section) continue
    const chars = sizes?.update[section.id] ?? section.size
    if (!chars) continue
    rows.push({ id: section.id, title: section.title, group: 'conversation', tokens: tokensOf(chars), chars, share: null, always: false, estimated: true })
  }
  const updateFraming = updatedIds.length ? sizes?.updateFraming ?? 0 : 0
  if (updateFraming > 0) {
    // The update message's own words, which carry the sections below into history.
    rows.push({ id: 'context-update', title: 'Context update framing', group: 'conversation', tokens: tokensOf(updateFraming), chars: updateFraming, share: null, always: false, estimated: true, note: 'the message the sections arrived in' })
  }

  const prefix = rows.slice()
  let prefixTokens = prefix.reduce((sum, row) => sum + row.tokens, 0)
  let note: string | null = approximate
    ? 'The pack was recorded without every per-section size, so the split is approximate.'
    : 'Rows are estimated from recorded characters, four per token, and reconciled to the measured request.'

  let messages = 0
  let source: 'measured' | 'estimate' = 'estimate'
  if (measuredTokens !== null) {
    source = 'measured'
    const remainder = measuredTokens - prefixTokens
    if (remainder >= 0) messages = remainder
    else {
      // The estimate overshot the provider's figure: scale the prefix down and say so, never go negative.
      const scale = prefixTokens > 0 ? measuredTokens / prefixTokens : 0
      for (const row of prefix) {
        row.tokens = Math.max(0, Math.floor(row.tokens * scale))
        row.note = 'scaled to the measured total'
      }
      prefixTokens = prefix.reduce((sum, row) => sum + row.tokens, 0)
      messages = 0
      note = 'The estimated prefix exceeded the measured request, so every row was scaled down to it.'
    }
    rows.push({ id: 'messages', title: 'Messages and tool results', group: 'conversation', tokens: messages, chars: null, share: null, always: false, estimated: false, note: 'measured by subtraction' })
  } else {
    note = `${note} No request has been measured yet.`
  }

  const reserve = snapshot?.compaction?.enabled === true ? Math.max(0, Math.round(snapshot.compaction.reserveTokens)) : null
  if (reserve !== null) {
    rows.push({ id: 'compaction-reserve', title: 'Compaction reserve', group: 'reserved', tokens: reserve, chars: null, share: null, always: true, estimated: true, note: 'Pi, auto-compaction' })
  }

  for (const row of rows) row.share = shareOf(row.tokens, window)
  const used = measuredTokens ?? prefixTokens
  const free = window === null ? null : Math.max(0, window - used - (reserve ?? 0))
  const totals: Record<ContextGroup, number> = { foundation: 0, variant: 0, application: 0, conversation: 0, reserved: 0 }
  for (const row of rows) totals[row.group] += row.tokens

  // One point per measured request, and where each compaction cut the window back.
  const history: ContextPoint[] = []
  const compactions: ContextCompaction[] = []
  for (const event of events) {
    if (event.type === 'usage.updated') {
      const payload = event.payload as Usage
      const used = typeof payload.contextTokens === 'number' ? payload.contextTokens : null
      const request = typeof payload.request?.index === 'number' ? payload.request.index : null
      // A provider that reports totals only still advances a request count.
      const index = request ?? (typeof payload.request === 'number' ? payload.request : null)
      if (used === null || index === null) continue
      history.push({ request: index, used, share: shareOf(used, window), at: event.timestamp })
    } else if (event.type === 'compaction.ended') {
      const payload = event.payload as { tokensBefore?: number; tokensAfter?: number }
      compactions.push({ at: event.timestamp, before: typeof payload.tokensBefore === 'number' ? payload.tokensBefore : null, after: typeof payload.tokensAfter === 'number' ? payload.tokensAfter : null })
    }
  }

  return {
    runId,
    model: usage?.model ?? null,
    provider: usage?.provider ?? null,
    window,
    used,
    share: shareOf(used, window),
    source,
    request: typeof usage?.request?.index === 'number' ? usage.request.index : null,
    compaction: reserve === null ? null : { enabled: true, reserveTokens: reserve },
    free,
    rows: rows.sort((left, right) => GROUP_ORDER.indexOf(left.group) - GROUP_ORDER.indexOf(right.group)),
    history,
    compactions,
    onDemand: onDemandOf(env, pack),
    totals,
    recordedAt: pack.compiledAt ?? null,
    note
  }
}

/** One row's text, for a surface that shows what a row actually contributed. */
export function rowText(env: HarnessEnv, runId: string, rowId: string): { id: string; title: string; text: string } | null {
  const pack = load(env.root, runId)
  if (!pack) return null
  if (rowId === 'tools-harness' || rowId === 'tools-application') {
    const events = readEvents(env.root, runId)
    const tools = lastEvent<Snapshot>(events, 'context.snapshot')?.tools ?? []
    if (!tools.length) return null
    const names = new Map<string, string>()
    for (const group of pack.toolGroups) for (const name of group.tools) names.set(name, group.group)
    const harnessOwned = rowId === 'tools-harness'
    const lines = tools
      .filter((tool) => HARNESS_TOOL_GROUPS.has(names.get(tool.name) ?? '') === harnessOwned)
      .map((tool) => `${names.get(tool.name) ?? 'Other tools'}: ${tool.name}`)
    return { id: rowId, title: harnessOwned ? 'Harness tool schemas' : 'Application tool schemas', text: lines.join('\n') }
  }
  const section = pack.sections.find((entry) => entry.id === rowId)
  if (!section) return null
  return { id: section.id, title: section.title, text: section.body }
}
