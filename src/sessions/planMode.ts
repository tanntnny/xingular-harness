// Plan mode: a run that may only look, ask and recall, and ends with a proposed plan. The tool list
// the model sees is unchanged, so switching the mode does not change the cached prompt prefix; the
// gate refuses everything else, and the instruction arrives as a context update.
import { deliveredSnapshot, type HostSection } from '../prompt/compile'
import { ASK_USER } from '../tools/askUser'

/**
 * Read-only inspection, questions and recall. Everything else is refused in plan mode: file
 * changes, commands, memory writes, delegation and connected apps, since none of them can be
 * judged read-only from their names. A provider marks its own read-only tools with `readOnly`.
 */
export const PLAN_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read', 'grep', 'find', 'ls', ASK_USER, 'ask_user_question',
  'history_search', 'history_read', 'trajectory_search', 'trajectory_read',
  'wiki_entrypoint', 'wiki_search', 'wiki_read', 'wiki_list', 'memory_facts', 'skill_load', 'mcp_list_tools'
])

export const PLAN_SECTION_ID = 'plan'
/** Between the application's role and the memory blocks. */
export const PLAN_SECTION_ORDER = 25
export const PLAN_OPEN_TAG = '<proposed_plan>'
export const PLAN_CLOSE_TAG = '</proposed_plan>'

export const PLAN_INSTRUCTIONS = `Plan mode is on for this request. Investigate and design; do not carry out the work.
- Read, search and recall freely. When a decision belongs to the user, ask with ${ASK_USER} instead of guessing.
- Do not change files, run commands, write memory, delegate, or call connected apps. Such calls are refused while plan mode is on.
- When the plan is ready, end the reply with exactly one block in this form, after any other text:
${PLAN_OPEN_TAG}
# <Plan title>
<Markdown: the context, the steps with the files they change, and how to verify the result>
${PLAN_CLOSE_TAG}
- If you need the user's input before a plan is possible, ask instead of proposing one.`

/** The tools a plan-mode run may call: the read-only set and the provider tools marked read-only. */
export function planModeTools(normal: readonly string[], readOnly: Iterable<string> = []): string[] {
  const allowed = new Set([...PLAN_READ_ONLY_TOOLS, ...readOnly])
  return normal.filter((name) => allowed.has(name))
}

/** Why a plan-mode run may not call this tool, or null when it may. */
export function planRefusal(tool: string, readOnly: ReadonlySet<string>): string | null {
  if (PLAN_READ_ONLY_TOOLS.has(tool) || readOnly.has(tool)) return null
  return `Plan mode is read-only: ${tool} is not available until the user leaves plan mode. Continue investigating, or finish with a ${PLAN_OPEN_TAG} block.`
}

/**
 * The plan section for this request. While plan mode is on it carries the instructions; on the
 * first request after it, the empty slot withdraws the earlier instructions from the conversation.
 * Otherwise there is no section, so a conversation that never planned is delivered exactly as before.
 */
export function planSection(plan: boolean, historyFile: string | null): HostSection | null {
  if (plan) return { id: PLAN_SECTION_ID, title: 'Plan mode', body: PLAN_INSTRUCTIONS, budget: 2000, order: PLAN_SECTION_ORDER, dynamic: true }
  const delivered = historyFile ? deliveredSnapshot(historyFile) : null
  return delivered?.some((entry) => entry.id === PLAN_SECTION_ID)
    ? { id: PLAN_SECTION_ID, title: 'Plan mode', body: null, budget: 2000, order: PLAN_SECTION_ORDER, dynamic: true }
    : null
}
