// The run's own todo list: the model writes the whole list each time, and the run records it as
// a `todo.updated` event. It only changes run state, so it stays callable in plan mode.
import { todoItemSchema, MAX_TODO_ITEMS, type TodoItem, type RunEvent } from '../sessions/contracts'
import type { ActiveRun } from '../sessions/registry'
import type { ToolSpec } from './types'

export const TODO_WRITE = 'todo_write'

/** The trigger the prompt and the tool description share, so progress guidance cannot drift. */
export const TODO_GUIDANCE =
  'If the work has several distinct steps or will take more than one tool call, call todo_write before your first other tool call with the steps you know so far, and keep the list current as steps start and finish. ' +
  'Keep the list true at all times: mark a step completed only once it is done and checked, and add steps you discover. An open step is work to do in this reply, not something to report; never mark unfinished work completed. ' +
  'The person follows your work from it, and a subagent’s todo list shows as its progress in the person’s list of subagents.'

/** The event a run writes; `checklist.updated` is the pre-rename name, still read for old runs. */
const TODO_EVENTS = new Set(['todo.updated', 'checklist.updated'])

const MARK = { pending: '[ ]', in_progress: '[~]', completed: '[x]' } as const

/** The todo list as the model reads it back. */
export function describeTodo(items: readonly TodoItem[]): string {
  if (!items.length) return 'The todo list is empty.'
  return items.map((item) => `${MARK[item.status]} ${item.text}`).join('\n')
}

/** The latest todo list a run wrote, or an empty list. Reads the pre-rename event too. */
export function todoOf(events: readonly RunEvent[]): TodoItem[] {
  const last = events.filter((event) => TODO_EVENTS.has(event.type)).at(-1)
  const items = (last?.payload as { items?: unknown } | undefined)?.items
  return Array.isArray(items) ? items.flatMap((item) => {
    const parsed = todoItemSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  }) : []
}

export function todoTool(run: Pick<ActiveRun, 'emit'>): ToolSpec {
  return {
    name: TODO_WRITE,
    label: 'Write the todo list',
    description:
      `Keep a todo list of the steps of the current work. The user watches this list to follow your progress. ${TODO_GUIDANCE} ` +
      'Send the whole list every time; it replaces the previous one. Do not use it for a single, simple step or for conversation. ' +
      'Statuses: pending, in_progress, completed. Keep exactly one step in_progress while you work, mark a step completed as soon as it is done (not in batches), and add steps you discover. ' +
      'Only mark a step completed when it is fully done; if something blocks it, keep it in_progress and add a step for the blocker.',
    parameters: (Type) =>
      Type.Object({
        items: Type.Array(Type.Object({
          text: Type.String({ description: 'One step, as a short imperative line' }),
          status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')])
        }), { maxItems: MAX_TODO_ITEMS })
      }),
    readOnly: true,
    planModeSafe: () => true,
    execute: async (input) => {
      if (!Array.isArray(input.items)) return 'Send items: the whole todo list as an array.'
      if (input.items.length > MAX_TODO_ITEMS) return `Keep the todo list to ${MAX_TODO_ITEMS} steps or fewer.`
      const items: TodoItem[] = []
      for (const raw of input.items) {
        const entry = raw as { text?: unknown; status?: unknown }
        const parsed = todoItemSchema.safeParse({ text: typeof entry?.text === 'string' ? entry.text.trim() : entry?.text, status: entry?.status })
        if (!parsed.success) return 'Every step needs text of 1 to 500 characters and a status of pending, in_progress or completed.'
        items.push(parsed.data)
      }
      run.emit('todo.updated', { items })
      return describeTodo(items)
    }
  }
}

/** @deprecated Use `TODO_WRITE`; kept for one release so embedders can migrate. */
export const CHECKLIST_WRITE = TODO_WRITE

/** @deprecated Use `todoOf`; kept for one release so embedders can migrate. */
export const checklistOf = todoOf
