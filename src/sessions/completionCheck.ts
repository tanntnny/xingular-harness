// The completion check (ADR-0071): when a reply that did work ends with its todo list closed or
// absent, the same model, at low effort and with a fresh context, judges the person's request
// against what the reply actually did. The doer never certifies its own early stop: the check says
// `done`, `continue` (the reply is sent back with the reason) or `needs_person`. The request is the
// goal; there is no command and no condition to write. Any failure leaves the reply as it was.
import type { TodoItem } from './contracts'

export type CheckVerdictKind = 'done' | 'continue' | 'needs_person'

export interface CheckVerdict {
  verdict: CheckVerdictKind
  reason: string
  /** The next concrete step, for `continue`. */
  next: string
}

/** What the check sends; kept small so a check costs a fraction of a reply. */
export const MAX_CHECK_TRANSCRIPT = 16_000
const MAX_TOOL_RESULT = 600
const MAX_TOOL_ARGS = 300
const MAX_TEXT = 2_000
export const CHECK_TIMEOUT_MS = 60_000

/** The fixed instructions of the check. Answering is all it does: it has no tools. */
export const CHECK_SYSTEM_PROMPT = `You review whether an AI coding agent may end its reply now. You do not do the work and you have no tools. You read the person's request, the agent's todo list, and a transcript of what the agent did in this reply, and you answer with one JSON object and nothing else:

{"verdict":"done"|"continue"|"needs_person","reason":"one or two sentences","next":"the next concrete step, for continue"}

The agent works in the person's working folder. Inside it, without asking, the agent may read and change files, run commands and tests, install dependencies, create branches, worktrees and files, choose the order of steps, choose between reasonable implementations, and retry a failed check another way. A document the request points to (a handoff, a plan, a spec) is part of the request: its steps are the work.

Answer "continue" when any part of the request remains that the agent can still do by itself inside those bounds. In particular:
- The agent asked the person something the request or the files already answer, or asked permission for something inside its bounds ("should I start with step 1?", "create the worktree?", "install dependencies?").
- The agent marked todo items completed, but its own text or the transcript shows that work is not done or not checked.
- The agent stopped after a failure it could work around or investigate itself.
- The agent finished one part of a multi-part request and reported the rest as remaining.

Answer "needs_person" only when the remaining work truly requires the person: a deploy or production change, a secret or credential the agent does not have, writing to remote data, spending money, access the agent lacks, an environment problem only the person can fix, or a product choice the request leaves open with no reasonable default. Name exactly what the person must do.

Answer "done" when the request is fulfilled, when the request was a question and the reply answers it, or when everything the agent could do is done and nothing in the transcript contradicts that.

Judge only from the request, the todo list and the transcript. Keep "reason" and "next" short and specific.`

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
  if (message.role === 'user') return `[User or harness]: ${clip(textOf(message.content), MAX_TEXT)}`
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
export function checkPrompt(request: string, todo: readonly TodoItem[], transcript: string): string {
  const list = todo.length ? todo.map((item) => `- [${item.status}] ${item.text}`).join('\n') : '(the agent wrote no todo list)'
  return [
    `## The person's request\n${clip(request.trim() || '(not recorded)', 4_000)}`,
    `## The agent's todo list\n${list}`,
    `## What the agent did in this reply\n${transcript || '(nothing recorded)'}`,
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
        if (verdict !== 'done' && verdict !== 'continue' && verdict !== 'needs_person') continue
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
 * `{ verdict: null }`, and the reply ends as it would have without the check.
 */
export async function runCompletionCheck(
  ask: CheckModel,
  input: { request: string; todo: readonly TodoItem[]; messages: readonly unknown[] },
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<{ verdict: CheckVerdict | null; answer: CheckAnswer | null; error?: string }> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, options.timeoutMs ?? CHECK_TIMEOUT_MS)
  try {
    const user = checkPrompt(input.request, input.todo, replyTranscript(input.messages, input.request))
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

/** `XINGULAR_STOP_GATE=off` / `XINGULAR_COMPLETION_CHECK=off` at launch switch a layer off, for experiments. */
export function launchSwitchOff(name: 'XINGULAR_STOP_GATE' | 'XINGULAR_COMPLETION_CHECK'): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  return value === 'off' || value === '0' || value === 'false'
}
