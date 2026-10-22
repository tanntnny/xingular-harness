// Pi owns session names and their history. Both execution paths bind this tool to
// the current native session; it never receives a target session id from the model.
import { invalid } from '../core/errors'
import type { ToolSpec } from './types'

export const SESSION_NAME = 'session_name'

export interface NamedSession {
  readonly sessionName?: string
  setSessionName(name: string): void
}

export function sessionNameTool(current: () => NamedSession | undefined): ToolSpec {
  return {
    name: SESSION_NAME,
    label: 'Name the session',
    description:
      'Set or revise this session’s name. Name meaningful work early, then revise the name when the overall objective changes; greetings alone need no name. ' +
      'Use one short imperative sentence describing the objective, at most six words, such as "Add web browser integrations". ' +
      'You may revise a manually assigned name. Keep a useful current name when the objective is unchanged. This only names your own session.',
    parameters: Type => Type.Object({ name: Type.String({ description: 'One short sentence describing the objective, at most six words' }) }),
    planModeSafe: () => true,
    execute: async input => {
      if (typeof input.name !== 'string') throw invalid('Send name as a short sentence of at most six words.')
      if (/[\x00-\x08\x0e-\x1f\x7f-\x9f]/u.test(input.name)) {
        throw invalid('Session names cannot contain terminal escapes or control characters.')
      }
      const name = input.name.replace(/\s+/gu, ' ').trim()
      if (!name || name.split(' ').length > 6) throw invalid('Use a non-empty session name of at most six words.')
      const session = current()
      if (!session) throw invalid('The native session is unavailable; try naming it again once it is ready.')
      if (session.sessionName !== name) session.setSessionName(name)
      return `Session name: ${name}`
    }
  }
}
