// `/btw <question>`: a side question answered by a separate, tool-free session while the main
// conversation carries on. It lives in a dock above the composer, never enters the transcript, the
// queue or the run history, and is gone on dismiss, on a session change, or when a new one replaces it.
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type AgentSession, type AgentSessionServices, type Theme
} from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui'

import { contentWidth, footerRow, neutralRule, padded, safeText } from './chrome'
import { getWorkingSpinnerFrames, SPINNER_INTERVAL_MS, spinnerFrameAt } from './workingStatus'

export const SIDE_PROMPT = [
  'You answer one short side question from a person whose main task is still running in another session.',
  'You have no tools: you cannot read or change files, run commands, browse, or call anything, and you must not say you did.',
  'Use the conversation excerpt for context and do not invent what it does not show. Answer briefly and plainly.'
].join(' ')

const TURNS = 6
const TURN_CHARS = 1_200
const TOTAL_CHARS = 6_000
const QUESTION_ROWS = 2
export const ANSWER_ROWS = 8

type Block = { type?: unknown; text?: unknown; name?: unknown }

function blocks(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content.filter((block): block is Block => typeof block === 'object' && block !== null) : []
}

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}…` : text

/**
 * A bounded plain-text excerpt of the main conversation: the last few user and assistant turns, the
 * tools an assistant turn called by name, and whether the reply is still running. Hidden reasoning,
 * tool inputs and results, and images are left out.
 */
export function sideQuestionSnapshot(messages: readonly unknown[], running: boolean): string {
  const turns: string[] = []
  for (const message of messages) {
    const { role, content } = (message ?? {}) as { role?: unknown; content?: unknown }
    if (role !== 'user' && role !== 'assistant') continue
    const parts = blocks(content)
    const text = parts.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => String(block.text)).join('\n').trim()
    const tools = [...new Set(parts.filter(block => block.type === 'toolCall' && typeof block.name === 'string').map(block => String(block.name)))]
    if (!text && !tools.length) continue
    turns.push(`${role === 'user' ? 'User' : 'Assistant'}: ${clip(safeText(text).replace(/\s+/g, ' ').trim(), TURN_CHARS)}${tools.length ? ` [used tools: ${tools.join(', ')}]` : ''}`)
  }
  let recent = turns.slice(-TURNS)
  while (recent.length > 1 && recent.join('\n').length > TOTAL_CHARS) recent = recent.slice(1)
  const lines = ['Conversation excerpt, oldest first:', ...(recent.length ? recent : ['(nothing yet)'])]
  if (running) lines.push('', 'The main reply is still running; its latest turn above may be unfinished.')
  return lines.join('\n')
}

/** What the controller needs from a session; a Pi `AgentSession` satisfies it through `createSideSession`. */
export interface SideSession {
  prompt(text: string): Promise<void>
  abort(): Promise<void>
  subscribe(listener: () => void): () => void
  answer(): string
  /** Why the provider ended the turn in error, if it did. */
  failure(): string | undefined
  dispose(): void
}

/** A separate in-memory session on the same account and model, with no tools, extensions, skills or project files. */
export async function createSideSession(services: AgentSessionServices, main: AgentSession): Promise<SideSession> {
  const model = main.model
  if (!model || model.id === 'unknown') throw new Error('Choose a model before asking a side question.')
  const settingsManager = SettingsManager.inMemory({})
  const resourceLoader = new DefaultResourceLoader({
    cwd: services.cwd, agentDir: services.agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: SIDE_PROMPT
  })
  await resourceLoader.reload()
  const { session } = await createAgentSession({
    cwd: services.cwd, agentDir: services.agentDir, modelRuntime: services.modelRuntime, settingsManager, resourceLoader,
    sessionManager: SessionManager.inMemory(services.cwd), model, thinkingLevel: 'off', noTools: 'all'
  })
  return {
    prompt: text => session.prompt(text),
    abort: () => session.abort(),
    subscribe: listener => session.subscribe(() => listener()),
    answer: () => session.getLastAssistantText() ?? '',
    failure: () => {
      const last = session.messages.at(-1) as { role?: string; stopReason?: string; errorMessage?: string } | undefined
      return last?.role === 'assistant' && last.stopReason === 'error' ? last.errorMessage ?? 'The provider returned an error.' : undefined
    },
    dispose: () => session.dispose()
  }
}

export type SideState = 'thinking' | 'answered' | 'failed'

export interface SideQuestionOptions {
  create(): Promise<SideSession>
  snapshot(): string
  theme(): Theme
  /** Puts the dock above the composer, or takes it away. */
  mount(dock: Component | undefined): void
  changed(): void
}

export class SideQuestion {
  private session: SideSession | undefined
  private unsubscribe: (() => void) | undefined
  private generation = 0
  private question = ''
  private answerText = ''
  private error: string | undefined
  private current: SideState | undefined
  private startedAt = 0
  private readonly dock: Component

  constructor(private readonly options: SideQuestionOptions) {
    this.dock = { invalidate: () => {}, render: width => this.render(width) }
  }

  get visible(): boolean { return this.current !== undefined }
  get state(): SideState | undefined { return this.current }

  /** Asks one question, replacing any earlier one. Empty text dismisses. */
  async ask(question: string): Promise<void> {
    const text = question.trim()
    if (!text) { await this.dismiss(); return }
    await this.release()
    const generation = ++this.generation
    this.question = text
    this.startedAt = Date.now()
    this.answerText = ''
    this.error = undefined
    this.current = 'thinking'
    this.options.mount(this.dock)
    this.options.changed()
    try {
      const session = await this.options.create()
      if (generation !== this.generation) { session.dispose(); return }
      this.session = session
      this.unsubscribe = session.subscribe(() => {
        if (generation !== this.generation) return
        this.answerText = session.answer()
        this.options.changed()
      })
      await session.prompt(`${this.options.snapshot()}\n\nSide question: ${text}`)
      if (generation !== this.generation) return
      this.answerText = session.answer()
      const failure = session.failure()
      if (failure) { this.current = 'failed'; this.error = failure } else this.current = 'answered'
    } catch (error) {
      if (generation !== this.generation) return
      this.current = 'failed'
      this.error = error instanceof Error ? error.message : String(error)
    }
    this.options.changed()
  }

  /** Interrupts a running side question and removes the dock. */
  async dismiss(): Promise<void> {
    this.generation++
    this.current = undefined
    await this.release()
    this.options.mount(undefined)
    this.options.changed()
  }

  private async release(): Promise<void> {
    const session = this.session
    this.session = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (!session) return
    try { await session.abort() } catch { /* A side run that cannot be stopped is still dropped. */ }
    try { session.dispose() } catch { /* Cleanup cannot keep the dock open. */ }
  }

  /** The dock: a neutral rule, the inline question, its answer, and a hint, separated by blank rows. */
  private render(width: number): string[] {
    if (width < 1 || !this.current) return []
    const theme = this.options.theme()
    const inner = contentWidth(width)
    const spinner = this.current === 'thinking'
      ? spinnerFrameAt(Date.now() - this.startedAt, getWorkingSpinnerFrames(process.env.TERM), SPINNER_INTERVAL_MS)
      : ''
    const marker = `${spinner ? `${spinner} ` : ''}/btw`
    const markerWidth = visibleWidth(marker) + 1
    const asked = wrapTextWithAnsi(safeText(this.question), Math.max(1, inner - markerWidth))
    const question = asked.slice(0, QUESTION_ROWS).map((line, index) => {
      const prefix = index === 0 ? `${theme.bold(theme.fg('accent', marker))} ` : ' '.repeat(markerWidth)
      return prefix + theme.fg('muted', line)
    })
    if (asked.length > QUESTION_ROWS) question[QUESTION_ROWS - 1] = truncateToWidth(question[QUESTION_ROWS - 1]!, inner - 1, '') + theme.fg('muted', '…')
    const text = this.current === 'failed' ? `${this.answerText ? `${this.answerText}\n` : ''}${this.error ?? 'The side question failed.'}` : this.answerText
    const wrapped = text ? text.split('\n').flatMap(line => line ? wrapTextWithAnsi(safeText(line), inner) : ['']) : []
    const shown = wrapped.slice(0, ANSWER_ROWS).map(line => this.current === 'failed' ? theme.fg('error', line) : line)
    const more = wrapped.length - shown.length
    return [
      neutralRule(width, theme),
      ...question.map(line => padded(line, width)),
      ...(shown.length ? ['', ...shown.map(line => padded(line, width))] : []),
      '',
      footerRow(`${more > 0 ? `+${more} more lines · ` : ''}/btw or Esc to dismiss`, width, theme)
    ].map(line => truncateToWidth(line, width, ''))
  }
}
