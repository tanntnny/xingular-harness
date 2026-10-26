// The reply's handoff when it reaches a work-slice budget (PROP-0041). The model writes it once,
// the run records it as a `checkpoint` event, and the next slice is told where this one stopped.
// It only changes run state, so it stays callable in plan mode.
import {
  checkpointCheckSchema,
  checkpointDecisionSchema,
  checkpointFileSchema,
  checkpointItemSchema,
  checkpointReasonSchema,
  MAX_CHECKPOINT_CHECKS,
  MAX_CHECKPOINT_DECISIONS,
  MAX_CHECKPOINT_DONE,
  MAX_CHECKPOINT_FILES,
  MAX_CHECKPOINT_SUMMARY,
  runEventPayloadSchemas,
  type Checkpoint
} from '../sessions/contracts'
import type { ActiveRun } from '../sessions/registry'
import type { RunEvent } from '../sessions/contracts'
import type { ToolSpec } from './types'

export const CHECKPOINT_WRITE = 'checkpoint_write'

/** What the model may send: the record without the numbers the harness fills in. */
export type CheckpointInput = Omit<Checkpoint, 'slice' | 'reason'> & {
  reason?: Checkpoint['reason']
}

export type CheckpointParse =
  | { ok: true; value: CheckpointInput }
  | { ok: false; error: string }

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** Trims and bounds one entry; an unusable entry is dropped rather than failing the whole record. */
function collect<T>(value: unknown, parse: (entry: unknown) => T | null, limit: number): T[] {
  if (!Array.isArray(value)) return []
  const out: T[] = []
  for (const entry of value.slice(0, limit)) {
    const parsed = parse(entry)
    if (parsed) out.push(parsed)
  }
  return out
}

/** The checkpoint as the model sent it, or one line saying what to fix. */
export function parseCheckpoint(value: unknown): CheckpointParse {
  if (!value || typeof value !== 'object') return { ok: false, error: 'Send checkpoint_write an object with summary and next.' }
  const input = value as Record<string, unknown>
  const summary = text(input.summary)
  if (summary.length > MAX_CHECKPOINT_SUMMARY) return { ok: false, error: `Keep summary to ${MAX_CHECKPOINT_SUMMARY} characters.` }
  if (text(input.next).length > 500) return { ok: false, error: 'Keep next to 500 characters.' }
  if (text(input.blocked).length > 500) return { ok: false, error: 'Keep blocked to 500 characters.' }
  const done = collect(input.done, (entry) => {
    const parsed = checkpointItemSchema.safeParse(entry)
    return parsed.success ? parsed.data : null
  }, MAX_CHECKPOINT_DONE)
  const files = collect(input.files, (entry) => {
    const parsed = checkpointFileSchema.safeParse(entry)
    return parsed.success ? parsed.data : null
  }, MAX_CHECKPOINT_FILES)
  const checks = collect(input.checks, (entry) => {
    const parsed = checkpointCheckSchema.safeParse(entry)
    return parsed.success ? parsed.data : null
  }, MAX_CHECKPOINT_CHECKS)
  const decisions = collect(input.decisions, (entry) => {
    const parsed = checkpointDecisionSchema.safeParse(entry)
    return parsed.success ? parsed.data : null
  }, MAX_CHECKPOINT_DECISIONS)
  if (!summary && !done.length && !text(input.next) && !files.length) {
    return { ok: false, error: 'A checkpoint needs a summary, a next step, or what is done; write the handoff the next slice will read.' }
  }
  const reason = input.reason === undefined ? undefined : checkpointReasonSchema.safeParse(input.reason)
  if (reason && !reason.success) return { ok: false, error: 'reason is budget, stuck, compaction-thrash or requested.' }
  return {
    ok: true,
    value: {
      summary,
      done,
      next: text(input.next),
      ...(text(input.blocked) ? { blocked: text(input.blocked) } : {}),
      files,
      checks,
      decisions,
      ...(reason && reason.success ? { reason: reason.data } : {})
    }
  }
}

/** The model's own checkpoint, filled in with this slice and why it was written. */
export function checkpointRecord(input: CheckpointInput, slice: number, fallbackReason: Checkpoint['reason']): Checkpoint {
  return { ...input, slice, reason: input.reason ?? fallbackReason }
}

/** The latest checkpoint a run recorded, if any. */
export function checkpointOf(events: readonly RunEvent[]): Checkpoint | null {
  const last = events.filter((event) => event.type === 'checkpoint').at(-1)
  if (!last) return null
  const parsed = runEventPayloadSchemas.checkpoint.safeParse(last.payload)
  return parsed.success ? parsed.data : null
}

const line = (value: string): string => value.replace(/\s+/gu, ' ').trim()

/** The checkpoint as the next slice reads it. Bounded by its parts; the caller clips the whole. */
export function describeCheckpoint(checkpoint: Checkpoint): string {
  const parts: string[] = []
  if (checkpoint.summary) parts.push(`Where the last slice stopped: ${line(checkpoint.summary)}`)
  if (checkpoint.done.length) parts.push(`Done:\n${checkpoint.done.map((entry) => `- ${line(entry.item)}${entry.evidence.length ? ` (${entry.evidence.map(line).join('; ')})` : ''}`).join('\n')}`)
  if (checkpoint.files.length) parts.push(`Files touched:\n${checkpoint.files.map((entry) => `- ${line(entry.path)}${entry.why ? `: ${line(entry.why)}` : ''}`).join('\n')}`)
  if (checkpoint.checks.length) {
    const failing = checkpoint.checks.filter((entry) => !entry.ok)
    const passing = checkpoint.checks.filter((entry) => entry.ok)
    if (passing.length) parts.push(`Checks that passed: ${passing.map((entry) => line(entry.command)).join('; ')}`)
    if (failing.length) parts.push(`Checks that failed:\n${failing.map((entry) => `- ${line(entry.command)}${entry.detail ? `: ${line(entry.detail)}` : ''}`).join('\n')}`)
  }
  if (checkpoint.decisions.length) parts.push(`Decisions:\n${checkpoint.decisions.map((entry) => `- ${line(entry.what)}${entry.why ? `: ${line(entry.why)}` : ''}`).join('\n')}`)
  if (checkpoint.blocked) parts.push(`Blocked: ${line(checkpoint.blocked)}`)
  if (checkpoint.next) parts.push(`Next step: ${line(checkpoint.next)}`)
  return parts.join('\n\n')
}

/** The checkpoint as the model reads it back after writing it. */
export function ackCheckpoint(checkpoint: Checkpoint): string {
  const counts = [
    checkpoint.done.length ? `${checkpoint.done.length} done` : '',
    checkpoint.files.length ? `${checkpoint.files.length} files` : '',
    checkpoint.checks.length ? `${checkpoint.checks.length} checks` : ''
  ].filter(Boolean).join(', ')
  return `Checkpoint recorded for slice ${checkpoint.slice}${counts ? ` (${counts})` : ''}.${checkpoint.next ? ` Next: ${line(checkpoint.next)}` : ''}`
}

export function checkpointTool(run: Pick<ActiveRun, 'emit'>, slice: number | (() => number)): ToolSpec {
  return {
    name: CHECKPOINT_WRITE,
    label: 'Write the handoff checkpoint',
    description:
      'Record where this reply stopped and what the next slice must know. Call it when the harness asks for a handoff at the end of a work slice, or before you stop on purpose. ' +
      'Include what is done (with the file or check that proves it), the single next step, anything blocking, the files you touched, the checks you ran with their outcome, and decisions the next slice must not revisit. ' +
      'It records run state for the next slice; it does not change files and does not replace your reply to the user.',
    parameters: (Type) =>
      Type.Object({
        summary: Type.Optional(Type.String({ description: 'Where this slice stopped, in 1 to 3 sentences (max 1200 characters)' })),
        done: Type.Optional(Type.Array(Type.Object({
          item: Type.String({ description: 'One finished step' }),
          evidence: Type.Optional(Type.Array(Type.String({ description: 'A path, a check command, or a decision that proves it' }), { maxItems: 5 }))
        }), { maxItems: MAX_CHECKPOINT_DONE })),
        next: Type.Optional(Type.String({ description: 'The single next step (max 500 characters)' })),
        blocked: Type.Optional(Type.String({ description: 'What stops progress, if anything (max 500 characters)' })),
        files: Type.Optional(Type.Array(Type.Object({
          path: Type.String(),
          why: Type.Optional(Type.String({ description: 'Why this file matters to the next slice' }))
        }), { maxItems: MAX_CHECKPOINT_FILES })),
        checks: Type.Optional(Type.Array(Type.Object({
          command: Type.String(),
          ok: Type.Boolean(),
          detail: Type.Optional(Type.String({ description: 'The failing line, when it failed' }))
        }), { maxItems: MAX_CHECKPOINT_CHECKS })),
        decisions: Type.Optional(Type.Array(Type.Object({
          what: Type.String(),
          why: Type.Optional(Type.String())
        }), { maxItems: MAX_CHECKPOINT_DECISIONS }))
      }),
    readOnly: true,
    planModeSafe: () => true,
    execute: async (input) => {
      const parsed = parseCheckpoint(input)
      if (!parsed.ok) return parsed.error
      const checkpoint = checkpointRecord(parsed.value, typeof slice === 'function' ? slice() : slice, 'requested')
      run.emit('checkpoint', checkpoint)
      return ackCheckpoint(checkpoint)
    }
  }
}
