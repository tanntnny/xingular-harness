// A run's handoff record: where a reply stopped and what the next one must know. The harness writes
// it from the run's own evidence (files, checks, todo, the completion check's verdict) when a reply stops
// with work left; the model no longer writes it (ADR-0069 removed `checkpoint_write`). Older runs'
// model-written checkpoints stay readable.
import { runEventPayloadSchemas, type Checkpoint, type RunEvent } from './contracts'

/** The removed model tool. Pinned capability sets from before ADR-0069 may still name it. */
export const LEGACY_CHECKPOINT_WRITE = 'checkpoint_write'

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
