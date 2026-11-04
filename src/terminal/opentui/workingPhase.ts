import { ACTIVE_SUBAGENT_STATUSES, type TerminalSubagentActivity } from '../subagentMonitor'
import { toolDisplayName } from '../toolName'
import { formatWorkingDuration } from '../tui/workingStatus'

/** A tool shorter than this keeps the lively verb; longer, the row says what it is waiting on. */
export const TOOL_PHASE_AFTER_MS = 10_000
/** No event at all for this long while no tool runs: the model has not answered yet. */
export const MODEL_QUIET_AFTER_MS = 60_000
/** From here the row also says that Esc stops the reply. */
export const STOP_HINT_AFTER_MS = 5 * 60_000

const CHILD_WAIT_TOOLS = new Set(['wait_subagents', 'spawn_subagent'])

export interface RetryPhase {
  attempt: number
  maxAttempts: number
  /** When the next attempt starts; in the past once it has. */
  retryAt: number
  error: string
}

export interface WorkingPhaseInput {
  now: number
  /** Tools of the reply that started and have not finished. */
  tools: ReadonlyMap<string, { name: string; at: number; detail?: string }>
  /** The reply's own subagents, as the roster has them. */
  subagents: readonly TerminalSubagentActivity[]
  retry: RetryPhase | null
  /** When anything last happened in the reply: a token, a tool, a turn. */
  progressAt: number | null
  /**
   * The model's last message ended the turn (no tool call), yet the reply has not settled. The
   * parent is joining its outstanding children (INV-RUN-9), so it is not the model that is slow.
   */
  answered?: boolean
}

const ago = (ms: number): string => formatWorkingDuration(Math.max(0, ms))

/** The part of a bash command worth showing in the row: its last words, without the path to the program. */
export function commandDetail(args: unknown, max = 48): string | undefined {
  const command = typeof args === 'object' && args !== null && typeof (args as { command?: unknown }).command === 'string' ? (args as { command: string }).command : ''
  const line = command.split('\n')[0]?.replace(/"?(?:\/[^\s"/]+)*\/([^\s"/]+)"?/gu, '$1').replace(/\s+/gu, ' ').trim() ?? ''
  if (!line) return undefined
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function waitingOnChildren(input: WorkingPhaseInput): string {
  const active = input.subagents.filter((child) => child.relation === 'subagent' && ACTIVE_SUBAGENT_STATUSES.has(child.status))
  if (!active.length) return 'Waiting on subagents'
  const heads = `Waiting on ${active.length} subagent${active.length === 1 ? '' : 's'}`
  const freshest = active
    .flatMap((child) => {
      const at = child.lastEventAt ? Date.parse(child.lastEventAt) : Number.NaN
      return Number.isFinite(at) ? [{ at, activity: child.activity }] : []
    })
    .sort((left, right) => right.at - left.at)[0]
  if (!freshest) return heads
  const quiet = input.now - freshest.at
  return quiet < 5_000 ? `${heads} · ${freshest.activity}` : `${heads} · last activity ${ago(quiet)} ago (${freshest.activity})`
}

/**
 * What the reply is really doing while it looks busy, or `null` when the working verb is honest.
 * The spinner and clock say a reply lives; this says what it waits on, so a long wait is not
 * mistaken for a hang, and a hang is not mistaken for a wait.
 */
export function workingPhase(input: WorkingPhaseInput): string | null {
  const { now, tools, retry, progressAt } = input
  if (retry) {
    const head = `Reconnecting ${retry.attempt}/${retry.maxAttempts}`
    const when = retry.retryAt > now ? ` · retry in ${Math.ceil((retry.retryAt - now) / 1000)}s` : ''
    return `${head}${when} · ${retry.error.replace(/\s+/g, ' ').slice(0, 80)}`
  }
  const running = [...tools.values()]
  if (running.length) {
    if (running.every((tool) => CHILD_WAIT_TOOLS.has(tool.name))) return waitingOnChildren(input)
    const oldest = Math.min(...running.map((tool) => tool.at))
    if (now - oldest < TOOL_PHASE_AFTER_MS) return null
    const names = [...new Set(running.map((tool) => toolDisplayName(tool.name) || tool.name))]
    const label = running.length > 1 && names.length === 1 ? `${names[0]} ×${running.length}` : names.join(', ')
    // One command running alone is named by what it runs, so a deliberate wait (a poll, a watcher)
    // is not mistaken for work.
    const detail = running.length === 1 ? running[0]?.detail : undefined
    const age = now - oldest
    return `Running ${label}${detail ? `: ${detail}` : ''} · ${ago(age)}${age >= STOP_HINT_AFTER_MS ? ' · Esc to stop' : ''}`
  }
  if (input.answered) {
    return input.subagents.some((child) => child.relation === 'subagent' && ACTIVE_SUBAGENT_STATUSES.has(child.status)) ? waitingOnChildren(input) : null
  }
  if (progressAt === null) return null
  const quiet = now - progressAt
  if (quiet < MODEL_QUIET_AFTER_MS) return null
  return quiet < STOP_HINT_AFTER_MS ? `Waiting for the model · no output for ${ago(quiet)}` : `No progress for ${ago(quiet)} · Esc to stop`
}
