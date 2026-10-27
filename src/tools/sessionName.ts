// Pi owns session names and their history. Both execution paths bind this tool to
// the current native session; it never receives a target session id from the model.
import { invalid } from '../core/errors'
import type { ToolSpec } from './types'

export const SESSION_NAME = 'session_name'

/** The trigger the prompt and the tool description share, so naming guidance cannot drift. */
export const SESSION_GUIDANCE =
  'If the request needs tools or changes state — not a greeting, thanks, or a short conversational reply — call session_name once before your first other tool call, naming the work from the request. ' +
  'Use one short imperative sentence of at most six words. Revise the name only when the overall objective changes; keep the current name when it does not.'

export interface NamedSession {
  readonly sessionName?: string
  setSessionName(name: string): void
}

/** The one name validation every caller uses: a short, single-line, control-free sentence. */
export function normalizeSessionName(value: unknown): string {
  if (typeof value !== 'string') throw invalid('Send name as a short sentence of at most six words.')
  if (/[\x00-\x08\x0e-\x1f\x7f-\x9f]/u.test(value)) {
    throw invalid('Session names cannot contain terminal escapes or control characters.')
  }
  const name = value.replace(/\s+/gu, ' ').trim()
  if (!name || name.split(' ').length > 6) throw invalid('Use a non-empty session name of at most six words.')
  return name
}

const CONVERSATIONAL = /^(?:hi|hello|hey|yo|thanks|thank you|ok|okay|sure|great|nice|cool|sounds good|got it|good morning|good afternoon|good evening|how are you|what'?s up)[.!?]*$/iu
const LEADING = /^(?:please|can you|could you|would you|i want you to|i'd like you to|help me|let'?s|go ahead and)[,\s]+/iu

/**
 * A provisional name for a substantive first request. It is deliberately mechanical: the model
 * can still revise it with session_name. Greetings and short conversational replies stay unnamed.
 */
export function deriveSessionName(text: string): string | null {
  if (typeof text !== 'string') return null
  const input = text.trim()
  if (!input || input.startsWith('!') || input.startsWith('```') || /^https?:\/\//iu.test(input)) return null
  if (CONVERSATIONAL.test(input)) return null
  if (/^continue\b/iu.test(input)) return 'Continue previous work'
  const sentence = input.split(/[.!?](?:\s|$)/u)[0] ?? input
  const cleaned = sentence
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/[`*_~#>]/gu, ' ')
    .replace(/[:;,]+/gu, ' ')
    .replace(LEADING, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!/[a-z]/iu.test(cleaned)) return null
  const words = cleaned.split(' ').filter(Boolean).slice(0, 6)
  if (!words.length) return null
  const name = words.join(' ').replace(/^[\p{P}\p{S}]+/u, '').replace(/[\p{P}\p{S}]+$/u, '').trim()
  if (!name) return null
  const capitalized = name[0]!.toUpperCase() + name.slice(1)
  try {
    return normalizeSessionName(capitalized)
  } catch {
    return null
  }
}

export function sessionNameTool(current: () => NamedSession | undefined): ToolSpec {
  return {
    name: SESSION_NAME,
    label: 'Name the session',
    description:
      `Set or revise this session’s name. ${SESSION_GUIDANCE} ` +
      'For example, "Add web browser integrations". You may revise a manually assigned name. This only names your own session.',
    parameters: Type => Type.Object({ name: Type.String({ description: 'One short sentence describing the objective, at most six words' }) }),
    planModeSafe: () => true,
    execute: async input => {
      const name = normalizeSessionName(input.name)
      const session = current()
      if (!session) throw invalid('The native session is unavailable; try naming it again once it is ready.')
      if (session.sessionName !== name) session.setSessionName(name)
      return `Session name: ${name}`
    }
  }
}
