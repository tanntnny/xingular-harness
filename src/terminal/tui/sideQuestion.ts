// `/btw <question>` asks the Harness side-question service for an independent, tool-free run.
// Its dock is temporary and never enters the main transcript or input queue.
import type { Theme } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui'

import type { RunEvent } from '../../sessions/contracts'
import type { SideQuestionContext, SideQuestionRead } from '../../sessions/sideQuestions'
import { contentWidth, footerRow, neutralRule, padded, safeText } from './chrome'
import { getWorkingSpinnerFrames, SPINNER_INTERVAL_MS, spinnerFrameAt } from './workingStatus'

const QUESTION_ROWS = 2
const ANSWER_ROWS = 8
const MAX_CLIENT_CONTEXT_CHARS = 300_000
const POLL_INTERVAL_MS = 160
export type SideState = 'thinking' | 'answered' | 'failed'

type Block = { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown; data?: unknown }
type SideQuestionStart = { runId: string; sessionId: string; nativeSessionId: string | null }

function blocks(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content.filter((block): block is Block => typeof block === 'object' && block !== null) : []
}

function contentText(content: unknown): string {
  return blocks(content).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => String(block.text)).join('\n').trim()
}

function serialized(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) ?? '' } catch { return '[unavailable]' }
}

/** Visible native history and tool activity, with hidden reasoning and image bytes omitted. */
export function sideQuestionSnapshot(messages: readonly unknown[], running: boolean): string {
  const lines: string[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const item = message as { role?: unknown; content?: unknown; toolName?: unknown; name?: unknown; toolCallId?: unknown }
    const parts = blocks(item.content)
    if (item.role === 'user' || item.role === 'assistant') {
      const text = parts.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => String(block.text)).join('\n').trim()
      if (text) lines.push(`${item.role === 'user' ? 'User' : 'Assistant'}:\n${safeText(text)}`)
      for (const call of parts.filter(block => block.type === 'toolCall')) {
        const name = typeof call.name === 'string' ? call.name : 'unknown tool'
        lines.push(`Assistant tool call (${name}):\n${safeText(serialized(call.arguments))}`)
      }
      if (parts.some(block => block.type === 'image')) lines.push(`${item.role === 'user' ? 'User' : 'Assistant'} attached an image; image bytes are omitted.`)
    } else if (item.role === 'toolResult') {
      const name = typeof item.toolName === 'string' ? item.toolName : typeof item.name === 'string' ? item.name : 'unknown tool'
      const output = contentText(item.content)
      lines.push(`Tool result (${name}${typeof item.toolCallId === 'string' ? `, ${item.toolCallId}` : ''}):\n${safeText(output || '(no text result)')}`)
      if (parts.some(block => block.type === 'image')) lines.push('Tool result also contained an image; image bytes are omitted.')
    }
  }
  if (!lines.length) lines.push('(No visible conversation messages yet.)')
  if (running) lines.push('The main reply is still running; its latest message may be unfinished.')
  const full = lines.join('\n\n')
  return full.length > MAX_CLIENT_CONTEXT_CHARS
    ? `[Earlier visible context omitted to fit the side-question request.]\n\n${full.slice(-MAX_CLIENT_CONTEXT_CHARS)}`
    : full
}

export interface SideQuestionOptions {
  context(): SideQuestionContext
  start(question: string, context: SideQuestionContext): Promise<SideQuestionStart>
  read(runId: string, afterSequence: number): Promise<SideQuestionRead>
  interrupt(runId: string): Promise<unknown>
  copyText(text: string): Promise<void>
  theme(): Theme
  /** Puts the dock above the composer, or takes it away. */
  mount(dock: Component | undefined): void
  changed(): void
}

function payload(event: RunEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {}
}

export class SideQuestion {
  private runId: string | undefined
  private generation = 0
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private question = ''
  private answerText = ''
  private error: string | undefined
  private current: SideState | undefined
  private startedAt = 0
  private afterSequence = -1
  private answerOffset = 0
  private readonly dock: Component

  constructor(private readonly options: SideQuestionOptions) {
    this.dock = { invalidate: () => {}, render: width => this.render(width) }
  }

  get visible(): boolean { return this.current !== undefined }
  get state(): SideState | undefined { return this.current }
  get answer(): string { return this.answerText }

  /** Asks one question, replacing any earlier one. Empty text dismisses. */
  async ask(question: string): Promise<void> {
    const text = question.trim()
    if (!text) { await this.dismiss(); return }
    const generation = ++this.generation
    await this.release()
    this.question = text
    this.startedAt = Date.now()
    this.answerText = ''
    this.error = undefined
    this.answerOffset = 0
    this.afterSequence = -1
    this.current = 'thinking'
    this.options.mount(this.dock)
    this.options.changed()
    try {
      const started = await this.options.start(text, this.options.context())
      if (generation !== this.generation) {
        await this.options.interrupt(started.runId).catch(() => undefined)
        return
      }
      this.runId = started.runId
      void this.poll(generation)
    } catch (error) {
      if (generation !== this.generation) return
      this.current = 'failed'
      this.error = error instanceof Error ? error.message : String(error)
      this.options.changed()
    }
  }

  /** Scrolls the answer while it is longer than the dock. */
  scroll(direction: 'up' | 'down'): void {
    const step = Math.max(1, ANSWER_ROWS - 2)
    this.answerOffset = Math.max(0, this.answerOffset + (direction === 'up' ? -step : step))
    this.options.changed()
  }

  /** Copies the whole side answer, including any lines outside the dock. */
  async copyAnswer(): Promise<void> {
    if (this.answerText) await this.options.copyText(this.answerText)
  }

  /** Interrupts a running side question and removes the dock. */
  async dismiss(): Promise<void> {
    this.generation++
    await this.release()
    this.current = undefined
    this.options.mount(undefined)
    this.options.changed()
  }

  private async poll(generation: number): Promise<void> {
    const runId = this.runId
    if (!runId || generation !== this.generation) return
    try {
      const result = await this.options.read(runId, this.afterSequence)
      if (generation !== this.generation) return
      for (const event of result.events) {
        this.afterSequence = Math.max(this.afterSequence, event.sequence)
        const data = payload(event)
        if (event.type === 'message.delta' && typeof data.text === 'string') this.answerText += data.text
        if (event.type === 'message.completed' && data.role === 'assistant' && typeof data.text === 'string') this.answerText = data.text
        if (event.type === 'failed') this.error = typeof data.message === 'string' ? data.message : 'The side question failed.'
        if (event.type === 'status.changed' && data.status === 'failed') this.error = typeof data.reason === 'string' ? data.reason : 'The side question failed.'
        if (event.type === 'status.changed' && data.status === 'interrupted') this.error = 'The side question was interrupted.'
        if (event.type === 'completed') this.current = 'answered'
        if (event.type === 'failed' || event.type === 'status.changed' && ['failed', 'interrupted'].includes(String(data.status))) this.current = 'failed'
      }
      if (result.run.status === 'completed') this.current = 'answered'
      if (result.run.status === 'failed' || result.run.status === 'interrupted') {
        this.current = 'failed'
        this.error ??= result.run.terminalReason ?? 'The side question did not complete.'
      }
      this.options.changed()
      if (this.current === 'thinking') this.pollTimer = setTimeout(() => { void this.poll(generation) }, POLL_INTERVAL_MS)
    } catch (error) {
      if (generation !== this.generation) return
      this.current = 'failed'
      this.error = error instanceof Error ? error.message : String(error)
      this.options.changed()
    }
  }

  private async release(): Promise<void> {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = undefined
    const runId = this.runId
    this.runId = undefined
    if (!runId || this.current !== 'thinking') return
    try { await this.options.interrupt(runId) } catch { /* The dock can still be dismissed if a run already stopped. */ }
  }

  /** The dock: question, a scrollable answer window, and a hint for browsing or copying. */
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
    const maxOffset = Math.max(0, wrapped.length - ANSWER_ROWS)
    this.answerOffset = Math.min(this.answerOffset, maxOffset)
    const shown = wrapped.slice(this.answerOffset, this.answerOffset + ANSWER_ROWS).map(line => this.current === 'failed' ? theme.fg('error', line) : line)
    const before = this.answerOffset
    const after = Math.max(0, wrapped.length - before - shown.length)
    const textHint = before || after ? `PgUp/PgDn browse · ${before ? `${before} above` : ''}${before && after ? ' · ' : ''}${after ? `${after} below` : ''} · ` : ''
    return [
      neutralRule(width, theme),
      ...question.map(line => padded(line, width)),
      ...(shown.length ? ['', ...shown.map(line => padded(line, width))] : []),
      '',
      footerRow(`${textHint}Ctrl+X copy · /btw or Esc dismiss`, width, theme)
    ].map(line => truncateToWidth(line, width, ''))
  }
}
