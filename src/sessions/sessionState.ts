// The current name and todo state a run sees in its request context. The structured path
// delivers this as a dynamic prompt section; the terminal appends the same text to the request.
import { readFileSync } from 'node:fs'

import type { TodoItem } from './contracts'

export interface SessionState {
  /** The name Pi has for this native session, or null while it is unnamed. */
  name: string | null
  /** This run's own todo list. A run starts with an empty list. */
  todo: readonly TodoItem[]
  /** A previous run's list, shown as context only. */
  previousTodo?: readonly TodoItem[]
  /** Whether this is the first turn in the native session. */
  firstTurn: boolean
}

/** The latest non-empty session_info name in a native history, or null. */
export function latestSessionName(historyFile: string | null): string | null {
  if (!historyFile) return null
  let text: string
  try {
    text = readFileSync(historyFile, 'utf8')
  } catch {
    return null
  }
  let name: string | null = null
  for (const line of text.split('\n')) {
    if (!line.includes('"session_info"')) continue
    try {
      const entry = JSON.parse(line) as { type?: unknown; name?: unknown }
      if (entry?.type === 'session_info') {
        const value = typeof entry.name === 'string' ? entry.name.trim() : ''
        name = value || null
      }
    } catch {
      // A malformed line is not a session name.
    }
  }
  return name
}
