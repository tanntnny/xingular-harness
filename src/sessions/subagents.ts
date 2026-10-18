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
}

export function subagentDepth(options: SubagentOptions | undefined): number {
  const value = Math.trunc(options?.maxDepth ?? DEFAULT_SUBAGENT_DEPTH)
  return Math.min(MAX_SUBAGENT_DEPTH, Math.max(1, Number.isFinite(value) ? value : DEFAULT_SUBAGENT_DEPTH))
}

export interface SubagentInput {
  parentRunId: string
  brief: string
  tools?: string[]
  wait?: boolean
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
