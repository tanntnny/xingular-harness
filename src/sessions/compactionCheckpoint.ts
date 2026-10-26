import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { renderCompactionCheckpoint } from '../prompt/compile'
import { CHECKLIST_WRITE } from '../tools/checklist'
import { checklistItemSchema, MAX_CHECKLIST_ITEMS, type ChecklistItem } from './contracts'

export const COMPACTION_CHECKPOINT_EXTENSION = 'compaction-checkpoint'

export interface CompactionCheckpointOptions {
  /** A stopped run's persisted checklist, when the active run is a continuation. */
  initialChecklist?: readonly ChecklistItem[]
  /** The current dynamic plan instructions, if this request is in plan mode. */
  planInstructions?: () => string | null
}

function validatedChecklist(value: unknown): ChecklistItem[] | null {
  if (!Array.isArray(value) || value.length > MAX_CHECKLIST_ITEMS) return null
  const items: ChecklistItem[] = []
  for (const valueItem of value) {
    const item = valueItem as { text?: unknown; status?: unknown } | null
    const parsed = checklistItemSchema.safeParse({
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
    let checklist = validatedChecklist(options.initialChecklist ?? []) ?? []
    let lastCompactionKey: string | null = null
    let compacted = false

    const reset = (): void => {
      goal = ''
      checklist = validatedChecklist(options.initialChecklist ?? []) ?? []
      lastCompactionKey = null
      compacted = false
    }

    pi.on('before_agent_start', (event) => {
      if (event.messageType !== 'user') return
      goal = event.prompt
      checklist = validatedChecklist(options.initialChecklist ?? []) ?? []
      lastCompactionKey = null
      compacted = false
    })

    pi.on('tool_result', (event) => {
      if (event.toolName !== CHECKLIST_WRITE || event.isError) return
      const items = validatedChecklist(event.input.items)
      if (items) checklist = items
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
      const content = renderCompactionCheckpoint({ goal, checklist, planInstructions })
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
