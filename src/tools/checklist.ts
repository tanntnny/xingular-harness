// The run's own checklist: the model writes the whole list each time, and the run records it as
// a `checklist.updated` event. It only changes run state, so it stays callable in plan mode.
import { checklistItemSchema, MAX_CHECKLIST_ITEMS, type ChecklistItem, type RunEvent } from '../sessions/contracts'
import type { ActiveRun } from '../sessions/registry'
import type { ToolSpec } from './types'

export const CHECKLIST_WRITE = 'checklist_write'

const MARK = { pending: '[ ]', in_progress: '[~]', completed: '[x]' } as const

/** The checklist as the model reads it back. */
export function describeChecklist(items: readonly ChecklistItem[]): string {
  if (!items.length) return 'The checklist is empty.'
  return items.map((item) => `${MARK[item.status]} ${item.text}`).join('\n')
}

/** The latest checklist a run wrote, or an empty list. */
export function checklistOf(events: readonly RunEvent[]): ChecklistItem[] {
  const last = events.filter((event) => event.type === 'checklist.updated').at(-1)
  const items = (last?.payload as { items?: unknown } | undefined)?.items
  return Array.isArray(items) ? items.flatMap((item) => {
    const parsed = checklistItemSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  }) : []
}

export function checklistTool(run: Pick<ActiveRun, 'emit'>): ToolSpec {
  return {
    name: CHECKLIST_WRITE,
    label: 'Write the checklist',
    description:
      'Keep a checklist of the steps of the current work, so you and the user can see progress. Send the whole list every time; it replaces the previous one. ' +
      'Use it when the work has three or more distinct steps, or when the user gives several things to do. Do not use it for a single, simple step or for conversation. ' +
      'Statuses: pending, in_progress, completed. Keep exactly one step in_progress while you work, mark a step completed as soon as it is done (not in batches), and add steps you discover. ' +
      'Only mark a step completed when it is fully done; if something blocks it, keep it in_progress and add a step for the blocker.',
    parameters: (Type) =>
      Type.Object({
        items: Type.Array(Type.Object({
          text: Type.String({ description: 'One step, as a short imperative line' }),
          status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')])
        }), { maxItems: MAX_CHECKLIST_ITEMS })
      }),
    readOnly: true,
    planModeSafe: () => true,
    execute: async (input) => {
      if (!Array.isArray(input.items)) return 'Send items: the whole checklist as an array.'
      if (input.items.length > MAX_CHECKLIST_ITEMS) return `Keep the checklist to ${MAX_CHECKLIST_ITEMS} steps or fewer.`
      const items: ChecklistItem[] = []
      for (const raw of input.items) {
        const entry = raw as { text?: unknown; status?: unknown }
        const parsed = checklistItemSchema.safeParse({ text: typeof entry?.text === 'string' ? entry.text.trim() : entry?.text, status: entry?.status })
        if (!parsed.success) return 'Every step needs text of 1 to 500 characters and a status of pending, in_progress or completed.'
        items.push(parsed.data)
      }
      run.emit('checklist.updated', { items })
      return describeChecklist(items)
    }
  }
}
