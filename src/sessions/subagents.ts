import { takeChars } from '../core/text'
import { findRun, loadRun, readEvents } from './runStore'

export const SPAWN_SUBAGENT = 'spawn_subagent'
export const WAIT_SUBAGENTS = 'wait_subagents'
export const SUBAGENT_RELATION = 'subagent'

/** How deep subagents may nest when the caller does not say. */
export const DEFAULT_SUBAGENT_DEPTH = 1
export const MAX_SUBAGENT_DEPTH = 3

export interface SubagentOptions {
  /** Maximum consecutive native subagent levels below a caller (1 to 3). */
  maxDepth?: number
  /** Distinct child conversations a run may start. */
  maxChildren?: number
  /** Children a run may start from one named profile; a name it omits uses `maxOther`. */
  maxByProfile?: Record<string, number>
  /** Children allowed from a named profile `maxByProfile` does not list. */
  maxOther?: number
  /** Children allowed when the caller starts one with no profile. */
  maxUnprofiled?: number
}

/** How many distinct children a run may start when the caller does not say. */
export const DEFAULT_SUBAGENT_CHILDREN = 4
/** The most a host may allow, so a mistyped setting cannot lift the budget entirely. */
export const MAX_SUBAGENT_CHILDREN = 50
/** Foundation limits for the profiles the harness ships; `maxByProfile` overrides them. */
export const DEFAULT_SUBAGENT_PROFILE_CHILDREN: Readonly<Record<string, number>> = { worker: 2, explorer: 3 }
export const DEFAULT_SUBAGENT_OTHER_PROFILE = 1
export const DEFAULT_SUBAGENT_UNPROFILED = 1
/** The bucket a child with no profile counts against. No profile name can be `*`. */
export const UNPROFILED_SUBAGENT = '*'

/** The children one run may start, by profile and in total. */
export interface SubagentQuota {
  children: number
  profiles: Readonly<Record<string, number>>
  other: number
  unprofiled: number
}

function limit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(MAX_SUBAGENT_CHILDREN, Math.max(0, Math.trunc(value)))
}

/** The effective budget: the caller's values merged over the foundation defaults. */
export function subagentQuota(options: SubagentOptions | undefined): SubagentQuota {
  const profiles: Record<string, number> = { ...DEFAULT_SUBAGENT_PROFILE_CHILDREN }
  const given = options?.maxByProfile
  if (given && typeof given === 'object' && !Array.isArray(given)) {
    for (const [raw, value] of Object.entries(given)) {
      const name = raw.trim()
      if (!name || name.length > 64 || /[\x00-\x1f\x7f]/u.test(name)) continue
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      profiles[name] = limit(value, profiles[name] ?? DEFAULT_SUBAGENT_OTHER_PROFILE)
    }
  }
  return {
    children: limit(options?.maxChildren, DEFAULT_SUBAGENT_CHILDREN),
    profiles,
    other: limit(options?.maxOther, DEFAULT_SUBAGENT_OTHER_PROFILE),
    unprofiled: limit(options?.maxUnprofiled, DEFAULT_SUBAGENT_UNPROFILED)
  }
}

/** The bucket a child counts against: its profile name, or the unprofiled bucket. */
export function subagentProfileKey(profile: string | null | undefined): string {
  const name = typeof profile === 'string' ? profile.trim() : ''
  return name || UNPROFILED_SUBAGENT
}

/** How many children this profile may still start under the quota. */
export function subagentProfileLimit(quota: SubagentQuota, key: string): number {
  return key === UNPROFILED_SUBAGENT ? quota.unprofiled : quota.profiles[key] ?? quota.other
}

export function subagentDepth(options: SubagentOptions | undefined): number {
  const value = Math.trunc(options?.maxDepth ?? DEFAULT_SUBAGENT_DEPTH)
  return Math.min(MAX_SUBAGENT_DEPTH, Math.max(1, Number.isFinite(value) ? value : DEFAULT_SUBAGENT_DEPTH))
}

export interface SubagentInput {
  parentRunId: string
  /** The task for a new child; with `continue`, an optional extra instruction. */
  brief?: string
  /** The short name the roster shows for the child (PROP-0030); the spawn tool requires it. */
  title?: string
  tools?: string[]
  wait?: boolean
  /** An agent profile by name (PROP-0029), or one of the parent variant's subagents (c5). */
  agent?: string
  /**
   * A stopped child to continue instead of starting a fresh one: its run id. The new child reopens
   * that child's own history and keeps its profile, tools, account and variant; `brief` is then an
   * optional extra instruction.
   */
  continue?: string
}

/** The words that tell a parent a stopped child can be continued rather than started again. */
export function continueHint(runId: string): string {
  return `Its conversation is saved: continue it with spawn_subagent { "continue": "${runId}" } if the work is still needed, instead of starting it again from scratch.`
}

/** A subagent title is one short imperative, at most this many words (PROP-0030). */
export const MAX_SUBAGENT_TITLE_WORDS = 6
const BRIEF_TITLE_LENGTH = 60

/** The title a subagent title input means after cleaning, or undefined when it is not one. */
export function subagentTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (/[\x00-\x08\x0e-\x1f\x7f-\x9f]/u.test(value)) return undefined
  const title = value.replace(/\s+/gu, ' ').trim()
  if (!title || title.split(' ').length > MAX_SUBAGENT_TITLE_WORDS) return undefined
  return title
}

/** A title read from a brief when the caller gave none: its first line, cut to a short length. */
export function briefTitle(brief: string | null): string {
  const line = (brief ?? '').split('\n').map((part) => part.replace(/\s+/gu, ' ').trim()).find(Boolean) ?? ''
  return line.length > BRIEF_TITLE_LENGTH ? `${line.slice(0, BRIEF_TITLE_LENGTH - 1)}…` : line
}

export interface SubagentSelection {
  parentRunId: string
  runIds?: string[]
}

export interface SubagentResult {
  runId: string
  status: string
  text: string
  terminalReason: string | null
}

export interface SubagentReceipt {
  version: 1
  ownerRunId: string
  spawned?: string[]
  delivered?: string[]
}

export const SUBAGENT_RECEIPT = 'xingularSubagents'
export const SUBAGENT_OWNER = 'xingular-subagent-owner'
export const SUBAGENT_RESULTS = 'xingular-subagent-results'

/** Read explicit native metadata, including entries retained before compaction. */
export function subagentHistory(entries: readonly unknown[]): { owners: string[]; receipts: SubagentReceipt[] } {
  const owners: string[] = []
  const receipts: SubagentReceipt[] = []
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, any>
    if (entry.type === 'custom' && entry.customType === SUBAGENT_OWNER && typeof entry.data?.runId === 'string') owners.push(entry.data.runId)
    const message = entry.type === 'message' ? entry.message : entry
    const receipt = message?.details?.[SUBAGENT_RECEIPT]
    if (!receipt || receipt.version !== 1 || typeof receipt.ownerRunId !== 'string') continue
    const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === 'string')
    if ((receipt.spawned !== undefined && !strings(receipt.spawned)) || (receipt.delivered !== undefined && !strings(receipt.delivered))) continue
    receipts.push(receipt)
  }
  return { owners, receipts }
}

/** Native nesting is independent of a host's other uses of the generic caller depth. */
export function subagentNesting(root: string, run: { relation?: string | null; parentRunId?: string | null }): number {
  let current: typeof run = run
  let depth = 0
  const visited = new Set<string>()
  while (current.relation === SUBAGENT_RELATION) {
    const parent = current.parentRunId
    if (!parent || visited.has(parent)) return MAX_SUBAGENT_DEPTH
    visited.add(parent)
    depth++
    const record = findRun(root, parent)
    if (!record) return MAX_SUBAGENT_DEPTH
    current = record
  }
  return depth
}

/** The child's final reply, or why it ended without one. */
export function subagentReport(root: string, runId: string): string {
  const run = loadRun(root, runId)
  const reply = readEvents(root, runId).filter((event) => event.type === 'message.completed' && (event.payload as { role?: unknown }).role === 'assistant').at(-1)
  const text = typeof (reply?.payload as { text?: unknown } | undefined)?.text === 'string' ? takeChars((reply!.payload as { text: string }).text, 16_000) : ''
  const lines = [`Subagent run ${runId} · ${run.status}`]
  if (text) lines.push(`Result:\n${text}`)
  else if (run.status === 'completed') lines.push('It finished without a written reply.')
  if (run.status !== 'completed' && run.terminalReason) lines.push(`Stopped because: ${run.terminalReason}`)
  return lines.join('\n')
}
