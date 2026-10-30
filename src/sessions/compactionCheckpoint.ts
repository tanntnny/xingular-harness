import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { renderCompactionCheckpoint } from '../prompt/compile'
import { TODO_WRITE } from '../tools/todo'
import { todoItemSchema, MAX_TODO_ITEMS, type TodoItem } from './contracts'

export const COMPACTION_CHECKPOINT_EXTENSION = 'compaction-checkpoint'

export interface CompactionCheckpointOptions {
  /** A stopped run's persisted todo, when the active run is a continuation. */
  initialTodo?: readonly TodoItem[]
  /** The current dynamic plan instructions, if this request is in plan mode. */
  planInstructions?: () => string | null
}

interface CheckpointMessage {
  role: 'custom'
  customType: typeof COMPACTION_CHECKPOINT_EXTENSION
  content: string
  display: false
  timestamp: number
}

function validatedTodo(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value) || value.length > MAX_TODO_ITEMS) return null
  const items: TodoItem[] = []
  for (const valueItem of value) {
    const item = valueItem as { text?: unknown; status?: unknown } | null
    const parsed = todoItemSchema.safeParse({
      text: typeof item?.text === 'string' ? item.text.trim() : item?.text,
      status: item?.status
    })
    if (!parsed.success) return null
    items.push(parsed.data)
  }
  return items
}

/**
 * Restores the active run's explicit state after a compaction that happened during that run. A run
 * that starts from already-compacted history keeps its request, todo and plan in live history, so it
 * gets nothing. The checkpoint is built once per compaction and sits right after the summary, so each
 * request stays the previous one plus new items; a moving checkpoint defeats provider caching.
 */
export function compactionCheckpoint(options: CompactionCheckpointOptions = {}) {
  return (pi: ExtensionAPI): void => {
    let goal = ''
    let todo = validatedTodo(options.initialTodo ?? []) ?? []
    // The summary already in context at the run's first request; undefined until that request.
    let baseline: { key: string | null } | undefined
    let checkpoint: { key: string; message: CheckpointMessage | null } | undefined

    const reset = (prompt = ''): void => {
      goal = prompt
      todo = validatedTodo(options.initialTodo ?? []) ?? []
      baseline = undefined
      checkpoint = undefined
    }

    pi.on('before_agent_start', (event) => {
      if (event.messageType !== 'user') return
      reset(event.prompt)
    })

    pi.on('tool_result', (event) => {
      if (event.toolName !== TODO_WRITE || event.isError) return
      const items = validatedTodo(event.input.items)
      if (items) todo = items
    })

    pi.on('context', (event) => {
      const index = event.messages.findLastIndex((message) => message.role === 'compactionSummary')
      const summary = index >= 0 ? event.messages[index] as { timestamp?: number; tokensBefore?: number } : undefined
      const key = summary ? `${summary.timestamp}:${summary.tokensBefore}` : null

      if (!baseline) {
        baseline = { key }
        return
      }
      if (!key || key === baseline.key) return

      if (checkpoint?.key !== key) {
        const content = renderCompactionCheckpoint({ goal, todo, planInstructions: options.planInstructions?.() ?? null })
        checkpoint = {
          key,
          message: content
            ? { role: 'custom', customType: COMPACTION_CHECKPOINT_EXTENSION, content, display: false, timestamp: Date.now() }
            : null
        }
      }
      if (!checkpoint.message) return
      return { messages: [...event.messages.slice(0, index + 1), checkpoint.message, ...event.messages.slice(index + 1)] }
    })

    pi.on('agent_settled', () => reset())
    pi.on('session_tree', () => reset())
  }
}
