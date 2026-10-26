import { usagePayloadSchema, type RunEvent, type RunStatus, type UsagePayload } from '../sessions/contracts'
import type { Effort } from '../sessions/runner'

/** The agent profile a child started from, as the roster shows it (PROP-0029). */
export interface TerminalSubagentProfile {
  name: string
  color: string
}

export interface TerminalSubagentRun {
  id: string
  parentRunId: string | null
  relation: 'subagent'
  /** The short name the parent gave the child (PROP-0030). */
  title: string
  goal: string | null
  status: RunStatus
  startedAt: string
  endedAt: string | null
  profile?: TerminalSubagentProfile | null
  /** The pinned account's display label; subagents never switch accounts. */
  accountLabel?: string | null
  /** Effective launch selection, superseded by provider-reported usage when available. */
  model?: string | null
  effort?: Effort | null
}

export type TerminalSubagentUsage = Partial<Pick<UsagePayload,
  'provider' | 'model' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' |
  'reasoningTokens' | 'costUsd' | 'costSource' | 'requests' | 'contextTokens' | 'contextWindow'
>>

export interface TerminalSubagentActivity extends TerminalSubagentRun {
  activity: string
  /** Cumulative run usage only; provider reasoning summaries and request details stay private. */
  usage: TerminalSubagentUsage | null
  /** How far the child's own checklist is: counts only, never the items. */
  checklist: { done: number; total: number } | null
}

export const ACTIVE_SUBAGENT_STATUSES = new Set<RunStatus>(['queued', 'running', 'waiting_for_approval', 'waiting_for_input'])

export function terminalSubagentDuration(activity: TerminalSubagentRun, now = Date.now()): string {
  const start = Date.parse(activity.startedAt)
  const end = activity.endedAt ? Date.parse(activity.endedAt) : now
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—'
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

export function terminalSubagentTone(status: RunStatus): 'success' | 'warning' | 'error' | 'muted' {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'error'
  if (ACTIVE_SUBAGENT_STATUSES.has(status)) return 'warning'
  return 'muted'
}

interface ActiveTool {
  sequence: number
  text: string
}

interface MutableActivity extends TerminalSubagentActivity {
  tools: Map<string, ActiveTool>
  lastTool: ActiveTool | null
}

function statusActivity(status: RunStatus): string {
  switch (status) {
    case 'queued': return 'Queued'
    case 'waiting_for_approval': return 'Waiting for approval'
    case 'waiting_for_input': return 'Waiting for input'
    case 'completed': return 'Completed'
    case 'failed': return 'Failed'
    case 'interrupted': return 'Interrupted'
    case 'running': return 'Working'
  }
}

function payloadOf(event: RunEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {}
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function latestTool(tools: Map<string, ActiveTool>): string | undefined {
  return [...tools.values()].sort((left, right) => right.sequence - left.sequence)[0]?.text
}

/** Volatile, read-only activity projection for the latest terminal parent run. */
export class SubagentMonitor {
  private parentRunId: string | null = null
  private readonly activities = new Map<string, MutableActivity>()

  begin(parentRunId: string): void {
    this.parentRunId = parentRunId
    this.activities.clear()
  }

  observe(parentRunId: string, run: TerminalSubagentRun, event: RunEvent): void {
    if (this.parentRunId !== parentRunId || run.relation !== 'subagent') return

    const row = this.activities.get(run.id) ?? {
      id: run.id,
      parentRunId: run.parentRunId,
      relation: run.relation,
      title: run.title,
      goal: run.goal,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      activity: statusActivity(run.status),
      checklist: null,
      profile: run.profile ?? null,
      accountLabel: run.accountLabel ?? null,
      model: run.model ?? null,
      effort: run.effort ?? null,
      usage: null,
      tools: new Map<string, ActiveTool>(),
      lastTool: null
    }
    row.parentRunId = run.parentRunId
    if (run.profile !== undefined) row.profile = run.profile
    if (run.accountLabel !== undefined) row.accountLabel = run.accountLabel
    if (run.model !== undefined && !row.usage?.model) row.model = run.model
    if (run.effort !== undefined) row.effort = run.effort
    row.title = run.title
    row.goal = run.goal
    row.status = run.status
    row.startedAt = run.startedAt
    row.endedAt = run.endedAt

    const payload = payloadOf(event)
    if (event.type === 'tool.started') {
      const toolCallId = stringOf(payload.toolCallId)
      const name = stringOf(payload.name) ?? 'Tool'
      if (toolCallId) row.tools.set(toolCallId, { sequence: event.sequence, text: name })
    } else if (event.type === 'tool.completed') {
      const toolCallId = stringOf(payload.toolCallId)
      const tool = toolCallId ? row.tools.get(toolCallId) : undefined
      if (tool && (!row.lastTool || tool.sequence >= row.lastTool.sequence)) row.lastTool = tool
      if (toolCallId) row.tools.delete(toolCallId)
    } else if (event.type === 'message.delta') {
      row.lastTool = null
      row.activity = 'Responding'
    } else if (event.type === 'usage.updated') {
      const parsed = usagePayloadSchema.safeParse(payload)
      if (parsed.success) {
        const usage = parsed.data
        row.usage = {
          ...(usage.provider === undefined ? {} : { provider: usage.provider }),
          ...(usage.model === undefined ? {} : { model: usage.model }),
          ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
          ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
          ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
          ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
          ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
          ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
          ...(usage.costSource === undefined ? {} : { costSource: usage.costSource }),
          ...(usage.requests === undefined ? {} : { requests: usage.requests }),
          ...(usage.contextTokens === undefined ? {} : { contextTokens: usage.contextTokens }),
          ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow })
        }
      }
    } else if (event.type === 'checklist.updated') {
      const items = Array.isArray(payload.items) ? payload.items as { status?: unknown }[] : []
      row.checklist = items.length ? { done: items.filter(item => item?.status === 'completed').length, total: items.length } : null
    }

    if (run.status !== 'running') row.tools.clear()
    row.activity = run.status === 'running'
      ? latestTool(row.tools) ?? row.lastTool?.text ?? (event.type === 'message.delta' ? 'Responding' : 'Working')
      : statusActivity(run.status)
    this.activities.set(run.id, row)
  }

  snapshot(parentRunId: string): TerminalSubagentActivity[] {
    if (this.parentRunId !== parentRunId) return []
    return [...this.activities.values()]
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id))
      .map(({ tools: _tools, lastTool: _lastTool, ...activity }) => activity)
  }

  clear(parentRunId?: string): void {
    if (parentRunId && this.parentRunId !== parentRunId) return
    this.parentRunId = null
    this.activities.clear()
  }
}
