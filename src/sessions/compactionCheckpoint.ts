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

/** Adds only the active run's explicit state to requests made after a compaction. */
export function compactionCheckpoint(options: CompactionCheckpointOptions = {}) {
  return (pi: ExtensionAPI): void => {
    let goal = ''
    let todo = validatedTodo(options.initialTodo ?? []) ?? []
    let lastCompactionKey: string | null = null
    let compacted = false

    const reset = (): void => {
      goal = ''
      todo = validatedTodo(options.initialTodo ?? []) ?? []
      lastCompactionKey = null
      compacted = false
    }

    pi.on('before_agent_start', (event) => {
      if (event.messageType !== 'user') return
      goal = event.prompt
      todo = validatedTodo(options.initialTodo ?? []) ?? []
      lastCompactionKey = null
      compacted = false
    })

    pi.on('tool_result', (event) => {
      if (event.toolName !== TODO_WRITE || event.isError) return
      const items = validatedTodo(event.input.items)
      if (items) todo = items
    })

    pi.on('context', (event) => {
      const summary = event.messages.findLast((message) => message.role === 'compactionSummary')
      const compactionKey = summary ? `${summary.timestamp}:${summary.tokensBefore}` : null
      const planInstructions = options.planInstructions?.() ?? null

      if (compactionKey && compactionKey !== lastCompactionKey) {
        lastCompactionKey = compactionKey
        compacted = true
      } else if (!compactionKey) {
        lastCompactionKey = null
        compacted = false
      }

      if (!compacted) return
      const content = renderCompactionCheckpoint({ goal, todo, planInstructions })
      if (!content) return
      return {
        messages: [...event.messages, {
          role: 'custom',
          customType: COMPACTION_CHECKPOINT_EXTENSION,
          content,
          display: false,
          timestamp: Date.now()
        }]
      }
    })

    pi.on('agent_settled', reset)
    pi.on('session_tree', reset)
  }
}
