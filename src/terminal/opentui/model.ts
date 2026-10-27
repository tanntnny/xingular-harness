import { sessionEntryToContextMessages, type AgentSession, type SessionEntry } from '@earendil-works/pi-coding-agent'

import { parseProposedPlan } from '../tui/planMode'
import type { TerminalCommandHelpGroup } from '../commandHelp'
import { ansiLabel, ansiPlain } from './ansi'

export type ToolStatus = 'running' | 'ok' | 'error' | 'pending'

export interface UserItem {
  kind: 'user'
  id: string
  text: string
  images: number
  timestamp: number
}

export interface AssistantItem {
  kind: 'assistant'
  id: string
  text: string
  model?: string
  streaming: boolean
  timestamp: number
}

export interface ThinkingItem {
  kind: 'thinking'
  id: string
  text: string
  streaming: boolean
}

export interface ToolItem {
  kind: 'tool'
  id: string
  toolCallId: string
  name: string
  summary: string
  status: ToolStatus
  output: string
  durationMs?: number
}

export interface ImageResultItem {
  kind: 'image-result'
  id: string
  text: string
  imageCount: number
  images: { data: string; mimeType: string }[]
  showImages: boolean
}

export interface NoticeItem {
  kind: 'notice'
  id: string
  text: string
  level: string
}

export interface CommandHelpItem {
  kind: 'command-help'
  id: string
  groups: readonly TerminalCommandHelpGroup[]
}

interface AnchoredNotice {
  afterMessageCount: number
  /** The last message when the notice was posted; it survives compaction, unlike the count. */
  anchor?: object
  sequence: number
  multiline: boolean
  item: NoticeItem | CommandHelpItem | TodoTranscriptItem
}

export interface BashItem {
  kind: 'bash'
  id: string
  command: string
  timestamp: number
  output: string
  running: boolean
  exitCode?: number
  cancelled: boolean
}

export interface CustomItem {
  kind: 'custom'
  id: string
  label: string
  text: string
}

export interface SummaryItem {
  kind: 'summary'
  id: string
  label: string
  text: string
}

export interface CompactionItem {
  kind: 'compaction'
  id: string
  summary: string
  tokensBefore?: number
}

/** A `todo_write` call, shown as the list it wrote rather than as a tool row. */
export interface TodoTranscriptItem {
  kind: 'todo'
  id: string
  /** Set for a tool call; absent for a `/todo` snapshot. */
  toolCallId?: string
  /** Set for a tool call; a command snapshot has no status mark. */
  status?: ToolStatus
  origin: 'tool' | 'command'
  items: readonly TodoEntry[]
}

export interface TodoEntry {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** A proposed plan block from a plan-mode reply, shown as a card. */
export interface PlanItem {
  kind: 'plan'
  id: string
  title: string
  body: string
  streaming: boolean
}

export type TranscriptItem =
  | UserItem
  | AssistantItem
  | ThinkingItem
  | ToolItem
  | ImageResultItem
  | NoticeItem
  | CommandHelpItem
  | BashItem
  | CustomItem
  | SummaryItem
  | CompactionItem
  | PlanItem
  | TodoTranscriptItem

export interface TranscriptView {
  items: readonly TranscriptItem[]
  hasUserMessages: boolean
  hasMultilineNotice: boolean
}

type LooseMessage = { role?: string; [key: string]: unknown }
type Block = { type?: string; [key: string]: unknown }

const MAX_TOOL_OUTPUT = 12_000
const OUTPUT_CLIP_MARKER = '\n… output clipped …\n'

function appendCapped(current: string, delta: string): string {
  const combined = current + delta
  if (combined.length <= MAX_TOOL_OUTPUT) return combined
  const available = MAX_TOOL_OUTPUT - OUTPUT_CLIP_MARKER.length
  const head = Math.ceil(available / 2)
  return `${combined.slice(0, head)}${OUTPUT_CLIP_MARKER}${combined.slice(-(available - head))}`
}

function blocks(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content.filter((item): item is Block => typeof item === 'object' && item !== null) as Block[] : []
}

function contentText(content: unknown): string {
  return blocks(content)
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => String(block.text))
    .join('\n')
}

function withoutBoldMarkers(text: string): string {
  return text.replace(/\*\*(.*?)\*\*/gs, '$1')
}

function imageCount(content: unknown): number {
  return blocks(content).filter(block => block.type === 'image').length
}

function imageContents(content: unknown): { data: string; mimeType: string }[] {
  return blocks(content).flatMap(block =>
    block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string'
      ? [{ data: block.data, mimeType: block.mimeType }]
      : []
  )
}

function stringField(message: LooseMessage, name: string): string | undefined {
  const value = message[name]
  return typeof value === 'string' ? value : undefined
}

function numberField(message: LooseMessage, name: string): number | undefined {
  const value = message[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function clip(text: string, limit = MAX_TOOL_OUTPUT): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… ${text.length - limit} more characters` : text
}

function argumentSummary(name: string, args: unknown): string {
  const value = (args ?? {}) as Record<string, unknown>
  const pick = (...names: string[]) => {
    for (const key of names) {
      const item = value[key]
      if (typeof item === 'string' && item.trim()) return item
    }
    return undefined
  }
  const path = pick('path', 'file_path', 'filePath', 'target')
  const summary = name === 'bash' || name === 'shell'
    ? pick('command', 'cmd')
    : name === 'grep'
      ? [pick('pattern'), pick('path')].filter(Boolean).join('  ')
      : name === 'find'
        ? [pick('pattern'), pick('path')].filter(Boolean).join('  ')
        : name === 'websearch' || name === 'web_search'
          ? pick('query')
          : name === 'webfetch' || name === 'web_fetch'
            ? pick('url')
            : name === 'spawn_subagent' || name === 'spawnSubagent'
              ? [pick('agent'), pick('title', 'brief', 'description', 'prompt')].filter(Boolean).join(' · ')
              : path
  if (summary) return ansiLabel(summary, 100)
  if (!args || typeof args !== 'object') return ''
  try { return ansiLabel(JSON.stringify(args), 100) }
  catch { return '' }
}

function toolOutput(message: LooseMessage): string {
  const text = ansiPlain(contentText(message.content))
  const details = message.details
  if (details && typeof details === 'object') {
    const diff = (details as Record<string, unknown>).diff
    if (typeof diff === 'string' && diff.trim()) return clip(`${text}${text ? '\n' : ''}${diff}`)
  }
  return clip(text)
}

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed'])

/** The items of a `todo_write` (or pre-rename `checklist_write`) call, or null when they are not a todo list. */
export function todoEntries(args: unknown): TodoEntry[] | null {
  const items = (args as { items?: unknown } | null | undefined)?.items
  if (!Array.isArray(items)) return null
  const entries: TodoEntry[] = []
  for (const item of items) {
    const entry = item as { text?: unknown; status?: unknown } | null
    if (!entry || typeof entry.text !== 'string' || !entry.text.trim() || typeof entry.status !== 'string' || !TODO_STATUSES.has(entry.status)) return null
    entries.push({ text: ansiLabel(entry.text.trim(), 500), status: entry.status as TodoEntry['status'] })
  }
  return entries
}

function sameTranscriptItem(left: TranscriptItem, right: TranscriptItem): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'todo' && right.kind === 'todo') {
    return left.id === right.id && left.origin === right.origin && left.toolCallId === right.toolCallId && left.status === right.status
      && JSON.stringify(left.items) === JSON.stringify(right.items)
  }
  const leftFields = Object.entries(left)
  const rightValues = right as unknown as Record<string, unknown>
  return leftFields.length === Object.keys(right).length
    && leftFields.every(([key, value]) => rightValues[key] === value)
}

/** Gives each object a stable number, so a cache key can say "this exact tool result". */
const objectIds = new WeakMap<object, number>()
let nextObjectId = 0
function objectId(value: object): number {
  let id = objectIds.get(value)
  if (id === undefined) objectIds.set(value, id = nextObjectId++)
  return id
}

interface CompactedHistory {
  /** Every message before the latest compaction, in order, kept messages included. */
  archive: LooseMessage[]
  /** Where the summary sits in Pi's list. */
  summaryIndex: number
  /** How many leading messages of Pi's list come from the compaction and the kept entries. */
  head: number
}

interface HistorySource {
  getBranch(): SessionEntry[]
  buildSessionProjection(): { entries: { sourceEntry: SessionEntry; messages: unknown[] }[] }
}

function compactedHistory(session: AgentSession): CompactedHistory | null {
  const manager = (session as unknown as { sessionManager?: Partial<HistorySource> }).sessionManager
  if (typeof manager?.getBranch !== 'function' || typeof manager.buildSessionProjection !== 'function') return null
  const branch = manager.getBranch()
  const at = branch.findLastIndex(entry => entry.type === 'compaction')
  if (at < 0) return null
  const compactionId = branch[at]!.id
  const earlier = new Set(branch.slice(0, at).map(entry => entry.id))
  const projected = manager.buildSessionProjection().entries
  const first = projected[0]
  if (!first || first.sourceEntry.id !== compactionId || first.messages.length === 0) return null
  let head = 0
  for (const entry of projected) {
    if (entry.sourceEntry.id !== compactionId && !earlier.has(entry.sourceEntry.id)) break
    head += entry.messages.length
  }
  return {
    archive: branch.slice(0, at).flatMap(entry => sessionEntryToContextMessages(entry) as unknown as LooseMessage[]),
    summaryIndex: first.messages.length - 1,
    head
  }
}

export class TranscriptModel {
  private session?: AgentSession
  /** Items derived from a finished message, reused while its position and tool results stay the same. */
  private messageItems = new WeakMap<object, { key: string; items: TranscriptItem[] }>()
  private hideThinking = false
  private showImages = true
  private expanded = false
  private notices: AnchoredNotice[] = []
  private nextNotice = 0
  private liveBash?: { command: string; id?: string; output: string; timestamp: number; previousCount: number }
  private cachedView?: TranscriptView
  private readonly cachedItems = new Map<string, TranscriptItem>()
  /** What a compaction took out of Pi's message list, rebuilt from the session history on bind. */
  private history?: CompactedHistory | null

  bind(session: AgentSession): void {
    this.session = session
    this.history = undefined
    this.invalidate()
  }

  clear(): void {
    this.session = undefined
    this.history = undefined
    this.notices = []
    this.liveBash = undefined
    this.invalidate()
  }

  // Pi mutates the session messages outside this model, so callers invalidate after runtime events.
  invalidate(): void {
    this.cachedView = undefined
  }

  beginBash(command: string): void {
    const messages = (this.session?.messages ?? []) as readonly LooseMessage[]
    this.liveBash = {
      command,
      output: '',
      timestamp: Date.now(),
      previousCount: messages.filter(message => message.role === 'bashExecution').length
    }
    this.invalidate()
  }

  appendBashOutput(id: string, delta: string): boolean {
    const live = this.liveBash
    if (!live || !delta || (live.id !== undefined && live.id !== id)) return false
    live.id ??= id
    live.output = appendCapped(live.output, delta)
    this.invalidate()
    return true
  }

  finishBash(): void {
    this.liveBash = undefined
    this.invalidate()
  }

  clearNotices(): void {
    this.notices = []
    this.invalidate()
  }

  setThinkingHidden(hidden: boolean): void {
    if (this.hideThinking === hidden) return
    this.hideThinking = hidden
    this.messageItems = new WeakMap()
    this.invalidate()
  }

  setImagesShown(shown: boolean): void {
    if (this.showImages === shown) return
    this.showImages = shown
    this.messageItems = new WeakMap()
    this.invalidate()
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded
  }

  get isExpanded(): boolean {
    return this.expanded
  }

  notice(text: string, level = 'info'): void {
    const lines = text.split(/\r\n?|\n/u).filter(line => line.trim())
    const multiline = lines.length > 1
    for (const line of lines) {
      const sequence = this.nextNotice++
      this.addNotice(sequence, multiline, { kind: 'notice', id: `notice-${sequence}`, text: line, level })
    }
    this.invalidate()
  }

  commandHelp(groups: readonly TerminalCommandHelpGroup[]): void {
    const sequence = this.nextNotice++
    this.addNotice(sequence, true, { kind: 'command-help', id: `command-help-${sequence}`, groups })
    this.invalidate()
  }

  /** A `/todo` snapshot: the list at the moment the command ran, with no tool row. */
  todo(items: readonly TodoEntry[]): void {
    const sequence = this.nextNotice++
    this.addNotice(sequence, true, { kind: 'todo', id: `todo-${sequence}`, origin: 'command', items })
    this.invalidate()
  }

  private addNotice(sequence: number, multiline: boolean, item: NoticeItem | CommandHelpItem | TodoTranscriptItem): void {
    const messages = this.session?.messages ?? []
    this.notices.push({ afterMessageCount: messages.length, anchor: messages.at(-1), sequence, multiline, item })
    if (this.notices.length > 60) this.notices = this.notices.slice(-60)
  }

  /**
   * Notices in the order they appear, each with the message index it goes before. Compaction
   * replaces the message list with a shorter one, so a notice follows the message it was posted
   * after; a notice whose message was summarized goes right after the compaction card.
   */
  private placedNotices(messages: readonly LooseMessage[]): { place: number; notice: AnchoredNotice }[] {
    const indexes = new Map<object, number>()
    messages.forEach((message, index) => indexes.set(message, index))
    const summary = messages.findIndex(message => message.role === 'compactionSummary')
    return this.notices.map(notice => {
      if (!notice.anchor) return { place: 0, notice }
      const index = indexes.get(notice.anchor)
      if (index !== undefined) return { place: index + 1, notice }
      return { place: summary >= 0 ? summary + 1 : Math.min(notice.afterMessageCount, messages.length), notice }
    }).sort((left, right) => left.place - right.place || left.notice.sequence - right.notice.sequence)
  }

  view(): TranscriptView {
    if (this.cachedView) return this.cachedView
    const session = this.session
    if (!session) return this.cachedView = {
      items: this.stabilize(this.notices.map(notice => notice.item)),
      hasUserMessages: false,
      hasMultilineNotice: this.notices.some(notice => notice.multiline)
    }
    const live = session.messages as readonly LooseMessage[]
    const messages = this.displayMessages(live)
    const streaming = (session.state as unknown as { streamingMessage?: LooseMessage }).streamingMessage
    const all = streaming && !messages.includes(streaming) ? [...messages, streaming] : messages
    const pending = (session.state as unknown as { pendingToolCalls?: ReadonlySet<string> }).pendingToolCalls ?? new Set<string>()
    const results = new Map<string, LooseMessage>()
    for (const message of messages) {
      if (message.role === 'toolResult' && typeof message.toolCallId === 'string') results.set(message.toolCallId, message)
    }
    const items: TranscriptItem[] = []
    const bashExecutionCount = live.filter(message => message.role === 'bashExecution').length
    const notices = this.placedNotices(messages)
    let noticeIndex = 0
    for (let index = 0; index < all.length; index += 1) {
      while (noticeIndex < notices.length && notices[noticeIndex]!.place <= index) {
        items.push(notices[noticeIndex++]!.notice.item)
      }
      const message = all[index]!
      if (message === streaming) {
        items.push(...this.messageItemsFor(message, index, true, results, pending))
        continue
      }
      const key = this.messageKey(message, index, results, pending)
      const cached = this.messageItems.get(message)
      if (cached && cached.key === key) {
        items.push(...cached.items)
        continue
      }
      const derived = this.messageItemsFor(message, index, false, results, pending)
      this.messageItems.set(message, { key, items: derived })
      items.push(...derived)
    }
    if (this.liveBash && bashExecutionCount === this.liveBash.previousCount) {
      items.push({
        kind: 'bash', id: `live-${this.liveBash.id ?? 'pending'}`, command: this.liveBash.command,
        timestamp: this.liveBash.timestamp, output: ansiPlain(this.liveBash.output), running: true, cancelled: false
      })
    }
    for (; noticeIndex < notices.length; noticeIndex += 1) items.push(notices[noticeIndex]!.notice.item)
    return this.cachedView = {
      items: this.stabilize(items),
      hasUserMessages: messages.some(message => message.role === 'user'),
      hasMultilineNotice: this.notices.some(notice => notice.multiline)
    }
  }

  /**
   * Pi's list after a compaction starts with the summary and the kept messages. The transcript
   * shows the whole conversation instead: everything before the compaction from the session
   * history, the summary, then what came after.
   */
  private displayMessages(live: readonly LooseMessage[]): readonly LooseMessage[] {
    if (this.history === undefined) {
      try { this.history = this.session ? compactedHistory(this.session) : null }
      catch { this.history = null }
    }
    const history = this.history
    if (!history || live.length < history.head || live[history.summaryIndex]?.role !== 'compactionSummary') return live
    return [...history.archive, live[history.summaryIndex]!, ...live.slice(history.head)]
  }

  /** What a message's items depend on besides the message itself. */
  private messageKey(message: LooseMessage, index: number, results: ReadonlyMap<string, LooseMessage>, pending: ReadonlySet<string>): string {
    let key = `${index}`
    if (message.role !== 'assistant') return key
    for (const block of blocks(message.content)) {
      if (block.type !== 'toolCall' || typeof block.id !== 'string') continue
      const result = results.get(block.id)
      key += result ? `|${objectId(result)}` : pending.has(block.id) ? '|r' : '|p'
    }
    return key
  }

  private messageItemsFor(message: LooseMessage, index: number, isStreaming: boolean, results: ReadonlyMap<string, LooseMessage>, pending: ReadonlySet<string>): TranscriptItem[] {
    const items: TranscriptItem[] = []
    const role = message.role
    if (role === 'user') {
      const text = contentText(message.content)
      const images = imageCount(message.content)
      if (!text && !images) return items
      items.push({ kind: 'user', id: `m${index}`, text, images, timestamp: numberField(message, 'timestamp') ?? 0 })
      return items
    }
    if (role === 'assistant') {
      const model = stringField(message, 'model')
      const content = blocks(message.content)
      let textIndex = 0
      for (const block of content) {
        if (block.type === 'thinking' && typeof block.thinking === 'string' && !this.hideThinking) {
          const text = block.redacted === true ? '[redacted thinking]' : withoutBoldMarkers(String(block.thinking))
          if (text.trim()) items.push({ kind: 'thinking', id: `m${index}.t${textIndex++}`, text, streaming: isStreaming })
        } else if (block.type === 'text' && typeof block.text === 'string') {
          const id = `m${index}.x${textIndex++}`
          const timestamp = numberField(message, 'timestamp') ?? 0
          const plan = parseProposedPlan(block.text)
          if (!plan) {
            if (block.text.trim()) items.push({ kind: 'assistant', id, text: block.text, model, streaming: isStreaming, timestamp })
            continue
          }
          if (plan.before) items.push({ kind: 'assistant', id: `${id}.b`, text: plan.before, model, streaming: isStreaming, timestamp })
          items.push({ kind: 'plan', id: `${id}.p`, title: plan.title, body: plan.body, streaming: isStreaming && !plan.complete })
          if (plan.after) items.push({ kind: 'assistant', id: `${id}.a`, text: plan.after, model, streaming: isStreaming, timestamp })
        } else if (block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string') {
          const result = results.get(block.id)
          const status: ToolStatus = result ? (result.isError === true ? 'error' : 'ok') : pending.has(block.id) ? 'running' : 'pending'
          const resultImageCount = result ? imageCount(result.content) : 0
          const id = `m${index}.c${textIndex++}`
          const todo = (block.name === 'todo_write' || block.name === 'checklist_write') && result?.isError !== true ? todoEntries(block.arguments) : null
          if (todo) {
            items.push({ kind: 'todo', id, origin: 'tool', toolCallId: block.id, status, items: todo })
            continue
          }
          items.push({
            kind: 'tool', id, toolCallId: block.id, name: block.name,
            summary: argumentSummary(block.name, block.arguments), status,
            output: result && resultImageCount === 0 ? toolOutput(result) : '',
            durationMs: result ? numberField(result, 'durationMs') : undefined
          })
          if (result && resultImageCount > 0) {
            items.push({
              kind: 'image-result', id: `${id}.image-result`, text: toolOutput(result),
              imageCount: resultImageCount, images: this.showImages ? imageContents(result.content) : [],
              showImages: this.showImages
            })
          }
        }
      }
      const stop = stringField(message, 'stopReason')
      const error = stringField(message, 'errorMessage')
      if (stop === 'error' && error) items.push({ kind: 'notice', id: `m${index}.error`, text: error, level: 'error' })
      if (stop === 'aborted') items.push({ kind: 'notice', id: `m${index}.aborted`, text: 'Stopped by the person.', level: 'warning' })
      return items
    }
    if (role === 'bashExecution') {
      const command = stringField(message, 'command') ?? ''
      if (!command) return items
      items.push({
        kind: 'bash', id: `m${index}`, command, timestamp: numberField(message, 'timestamp') ?? 0,
        output: clip(ansiPlain(stringField(message, 'output') ?? '')),
        running: false, exitCode: numberField(message, 'exitCode'), cancelled: message.cancelled === true
      })
      return items
    }
    if (role === 'custom') {
      if (message.display === false) return items
      const text = contentText(message.content)
      if (!text.trim()) return items
      items.push({ kind: 'custom', id: `m${index}`, label: stringField(message, 'customType') ?? 'Extension', text })
      return items
    }
    if (role === 'compactionSummary') {
      const summary = stringField(message, 'summary') ?? ''
      if (!summary.trim()) return items
      items.push({ kind: 'compaction', id: `m${index}`, summary, tokensBefore: numberField(message, 'tokensBefore') })
      return items
    }
    if (role === 'branchSummary') {
      const text = stringField(message, 'summary') ?? ''
      if (text.trim()) items.push({ kind: 'summary', id: `m${index}`, label: 'Branch summary', text })
    }
    return items
  }

  private stabilize(items: TranscriptItem[]): TranscriptItem[] {
    const stable = items.map(item => {
      const cached = this.cachedItems.get(item.id)
      if (cached && sameTranscriptItem(cached, item)) return cached
      this.cachedItems.set(item.id, item)
      return item
    })
    const currentIds = new Set(stable.map(item => item.id))
    for (const id of this.cachedItems.keys()) {
      if (!currentIds.has(id)) this.cachedItems.delete(id)
    }
    return stable
  }
}
