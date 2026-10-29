// Which browser and computer actions need a person's yes, whatever standing approvals say: those
// that send, spend, delete, change an account or grant access. A tool describes its target
// (a button's name, a field's label) and asks here before it acts.
import type { ActiveRun } from '../sessions/registry'

export type ActionCategory = 'send' | 'purchase' | 'delete' | 'account' | 'access'

const RULES: readonly { category: ActionCategory; pattern: RegExp; reason: string }[] = [
  { category: 'send', pattern: /\b(send|submit|post|publish|reply|tweet|comment|email|message|share)\b/i, reason: 'send a message or submit a form' },
  { category: 'purchase', pattern: /\b(buy|purchase|pay|checkout|check out|place order|order now|subscribe|donate|add card|confirm payment)\b/i, reason: 'spend money' },
  { category: 'delete', pattern: /\b(delete|remove|erase|destroy|trash|discard|unsubscribe|cancel (my |your )?(account|subscription|plan))\b/i, reason: 'delete data' },
  { category: 'account', pattern: /\b(password|passcode|2fa|two-factor|security|sign out|log out|account settings|change email|recovery)\b/i, reason: 'change account or security settings' },
  { category: 'access', pattern: /\b(authorize|allow access|grant|permit|connect account|install|accept invitation|approve)\b/i, reason: 'grant access' }
]

/** The first category a target's description falls into, or null. */
export function classifyAction(description: string): { category: ActionCategory; reason: string } | null {
  const rule = RULES.find((candidate) => candidate.pattern.test(description))
  return rule ? { category: rule.category, reason: rule.reason } : null
}

/** Fields a tool never fills: the person types these themselves. */
export const SENSITIVE_FIELD = /\b(password|passcode|pin|one[- ]time|otp|verification code|security code|cvv|cvc|card number|credit card|iban|ssn|social security)\b/i

/** What a log keeps of typed text. */
export const redactTyped = (text: string): string => `[${text.length} characters]`

/** Whether a run has a person who can answer. */
export function unattended(run: ActiveRun | null | undefined, trigger: string | null | undefined): boolean {
  return !run || trigger === 'probe' || trigger === 'improver' || trigger === 'reflection'
}

export interface ActionAsk {
  run: ActiveRun
  tool: string
  /** What will be acted on, in words a person reads: "button “Send” on mail.example.com". */
  target: string
  args: Record<string, unknown>
  reason: string
}

/** Asks the person, never a standing approval. Returns a refusal text or null when approved. */
export async function askForAction(ask: ActionAsk): Promise<string | null> {
  const decision = await ask.run.requestApproval({
    target: ask.tool,
    action: `${ask.target} — this would ${ask.reason}`,
    operation: { tool: ask.tool, args: ask.args },
    rememberable: false,
    standing: 'none'
  })
  return decision === 'approved' ? null : 'The user denied this action. Do not repeat it or ask for permission in a message; choose another approach or report what is blocked.'
}
