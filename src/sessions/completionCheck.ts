// The goal-claim check (ADR-0072; it began as the completion check of ADR-0071): when the model
// of a /goal calls update_goal(complete), the same model, at low effort and with a fresh context,
// judges the claim against the goal's objective and what the transcript shows. The doer never
// certifies its own completion unchecked: the check says `done` (the goal is complete) or
// `continue` (it stays active with the reason). Any failure accepts the claim, as before.
// An ordinary reply has no check: it settles as it ends (ADR-0075).
export type CheckVerdictKind = 'done' | 'continue'

export interface CheckVerdict {
  verdict: CheckVerdictKind
  reason: string
  /** The next concrete step, for `continue`. */
  next: string
}

/** What the check sends; kept small so a check costs a fraction of a round. */
export const MAX_CHECK_TRANSCRIPT = 24_000
const MAX_TOOL_RESULT = 600
const MAX_TOOL_ARGS = 300
const MAX_TEXT = 2_000
export const CHECK_TIMEOUT_MS = 60_000

/** The fixed instructions of the check. Answering is all it does: it has no tools. */
export const CHECK_SYSTEM_PROMPT = `You verify whether an AI coding agent has achieved a goal a person gave it. You do not do the work and you have no tools. You read the goal objective and a transcript of what the agent did and said, and you answer with one JSON object and nothing else:

{"verdict":"done"|"continue","reason":"one or two sentences","next":"the next concrete step, for continue"}

Treat completion as unproven. Derive the concrete requirements from the objective and from any file, plan or spec it points to that the transcript shows. For every explicit requirement, numbered item, named artifact, command, test, gate and deliverable, look in the transcript for evidence that it was achieved and checked: command output, test results, file contents the agent read or wrote. Evidence that is weak, indirect or missing counts as not achieved. The agent saying the goal is complete is not evidence. Match the scope of the check to the scope of the requirement: a narrow check does not support a broad claim.

Answer "done" only when every requirement has evidence in the transcript. Quote the key evidence in "reason". Answer "continue" when any requirement is unmet, unchecked or unclear; name the unmet requirements in "reason" and the next step in "next". If the transcript does not contain clear evidence that the objective is met, answer "continue" with the reason "insufficient evidence in transcript".

Judge only from the objective and the transcript. Keep "reason" and "next" short and specific.`

const clip = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`)

type Part = { type?: string; text?: string; name?: string; arguments?: unknown }
type LlmMessage = { role?: string; content?: unknown; toolName?: string; isError?: boolean }

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Part[]).filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n')
}

/** One message as the check reads it: visible text, tool calls and clipped tool results. Thinking is left out. */
function renderMessage(message: LlmMessage): string {
  if (message.role === 'user') {
    const text = textOf(message.content)
    // The goal's own continuation prompts repeat the same long audit text; the check needs only the objective.
    if (text.startsWith('Continue working toward the active thread goal.')) return ''
    return `[User or harness]: ${clip(text, MAX_TEXT)}`
  }
  if (message.role === 'toolResult') return `[Tool result${message.toolName ? ` ${message.toolName}` : ''}${message.isError ? ', error' : ''}]: ${clip(textOf(message.content), MAX_TOOL_RESULT)}`
  if (message.role === 'assistant') {
    const parts = Array.isArray(message.content) ? message.content as Part[] : []
    const lines: string[] = []
    for (const part of parts) {
      if (part?.type === 'text' && part.text) lines.push(`[Agent]: ${clip(part.text, MAX_TEXT)}`)
      else if (part?.type === 'toolCall') lines.push(`[Agent tool call] ${part.name ?? 'tool'}(${clip(JSON.stringify(part.arguments ?? {}), MAX_TOOL_ARGS)})`)
    }
    return lines.join('\n')
  }
  return ''
}

/**
 * The reply's transcript: from the person's request onward, clipped to `limit` with the newest
 * messages kept. The request is found as the last user message that contains its opening text;
 * without it, the tail of the conversation stands in.
 */
export function replyTranscript(messages: readonly unknown[], request: string, limit = MAX_CHECK_TRANSCRIPT): string {
  const list = messages as LlmMessage[]
  const probe = request.trim().slice(0, 80)
  let start = 0
  if (probe) {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (list[index]?.role === 'user' && textOf(list[index].content).includes(probe)) {
        start = index
        break
      }
    }
  }
  const rendered = list.slice(start).map(renderMessage).filter(Boolean)
  const kept: string[] = []
  let size = 0
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const line = rendered[index]
    if (size + line.length + 1 > limit) {
      kept.unshift('[…earlier messages of this reply omitted…]')
      break
    }
    kept.unshift(line)
    size += line.length + 1
  }
  return kept.join('\n')
}

/** The check's user message. */
export function checkPrompt(objective: string, transcript: string): string {
  return [
    `## The goal's objective\n${clip(objective.trim() || '(not recorded)', 4_000)}`,
    `## What the agent did\n${transcript || '(nothing recorded)'}`,
    '## Your answer\nOne JSON object: verdict, reason, next.'
  ].join('\n\n')
}

/** The verdict in the check's text, or `null` when there is none: the first JSON object that parses. */
export function parseVerdict(text: string): CheckVerdict | null {
  const starts: number[] = []
  for (let index = text.indexOf('{'); index >= 0; index = text.indexOf('{', index + 1)) starts.push(index)
  for (const start of starts) {
    for (let end = text.indexOf('}', start); end >= 0; end = text.indexOf('}', end + 1)) {
      try {
        const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
        const verdict = value.verdict
        if (verdict !== 'done' && verdict !== 'continue') continue
        return {
          verdict,
          reason: clip(typeof value.reason === 'string' ? value.reason.trim() : '', 500),
          next: clip(typeof value.next === 'string' ? value.next.trim() : '', 500)
        }
      } catch {
        // Not a complete object yet; try a longer span.
      }
    }
  }
  return null
}

/** A model answer as the check needs it: its text, and what it cost for the run's usage. */
export interface CheckAnswer {
  text: string
  /** The provider's message, passed to the usage recorder unchanged. */
  message?: unknown
}

/** Asks a model once. Implemented over Pi's model registry by the caller. */
export type CheckModel = (system: string, user: string, signal: AbortSignal) => Promise<CheckAnswer>

/**
 * Runs one check. Never throws: a timeout, an error or an answer without a verdict returns
 * `{ verdict: null }`, and the claim is accepted as it stands.
 */
export async function runCompletionCheck(
  ask: CheckModel,
  input: { objective: string; messages: readonly unknown[] },
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<{ verdict: CheckVerdict | null; answer: CheckAnswer | null; error?: string }> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, options.timeoutMs ?? CHECK_TIMEOUT_MS)
  try {
    const user = checkPrompt(input.objective, replyTranscript(input.messages, ''))
    const answer = await ask(CHECK_SYSTEM_PROMPT, user, controller.signal)
    return { verdict: parseVerdict(answer.text), answer }
  } catch (error) {
    return { verdict: null, answer: null, error: controller.signal.aborted ? 'the completion check timed out' : error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

/** The text of a model's answer message. */
export function answerText(message: unknown): string {
  return textOf((message as { content?: unknown } | null)?.content)
}

/** The model a goal-claim check asks: the session's own model, at low effort, through Pi's registry. */
export function sessionCheckModel(ctx: unknown): CheckModel | null {
  const session = (ctx ?? {}) as {
    model?: { reasoning?: boolean }
    modelRegistry?: { streamSimple: (model: never, context: never, options?: never) => { result(): Promise<unknown> } }
    sessionManager?: { getSessionId?: () => string }
  }
  const model = session.model
  const registry = session.modelRegistry
  if (!model || !registry) return null
  // Some providers (opencode-go) reject a request without a session id.
  const sessionId = session.sessionManager?.getSessionId?.()
  return async (system, user, signal) => {
    const context = { systemPrompt: system, messages: [{ role: 'user', content: user, timestamp: Date.now() }] }
    const message = await registry.streamSimple(model as never, context as never, { ...(model.reasoning ? { reasoning: 'low' } : {}), ...(sessionId ? { sessionId } : {}), maxTokens: 4_000, signal } as never).result()
    const failed = (message as { stopReason?: string; errorMessage?: string }).stopReason
    if (failed === 'error' || failed === 'aborted') throw new Error((message as { errorMessage?: string }).errorMessage || `the check request ended: ${failed}`)
    return { text: answerText(message), message }
  }
}

/** `XINGULAR_COMPLETION_CHECK=off` at launch accepts every goal claim unchecked, for experiments. */
export function launchSwitchOff(name: 'XINGULAR_COMPLETION_CHECK'): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  return value === 'off' || value === '0' || value === 'false'
}
