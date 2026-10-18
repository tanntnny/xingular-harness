import { ASK_USER } from '../../tools/askUser'

// Read-only inspection, questions and recall. Everything else is withdrawn in plan mode: file changes, commands,
// memory writes, delegation and connected apps, since none of them can be judged read-only from their names.
const READ_ONLY_TOOLS = new Set([
  'read', 'grep', 'find', 'ls', ASK_USER, 'ask_user_question',
  'history_search', 'history_read', 'wiki_entrypoint', 'wiki_search', 'wiki_read', 'wiki_list', 'memory_facts'
])

export function planModeTools(normal: readonly string[]): string[] {
  return normal.filter(name => READ_ONLY_TOOLS.has(name))
}
