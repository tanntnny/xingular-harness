// The session tree behind `/tree`, without any drawing: the visible rows after a filter and a search,
// their branch connectors, which branches are folded, and which row is selected. The behaviour
// follows Pi's own tree selector so a conversation navigates exactly as it did before.
import type { SessionEntry, SessionTreeNode } from '@earendil-works/pi-coding-agent'

export type TreeFilterMode = 'default' | 'no-tools' | 'user-only' | 'labeled-only' | 'all'
export const TREE_FILTER_MODES: readonly TreeFilterMode[] = ['default', 'no-tools', 'user-only', 'labeled-only', 'all']

interface Gutter { position: number; show: boolean }

export interface FlatNode {
  node: SessionTreeNode
  indent: number
  showConnector: boolean
  isLast: boolean
  gutters: Gutter[]
  isVirtualRootChild: boolean
}

type Message = {
  role?: string; content?: unknown; stopReason?: string; errorMessage?: string
  command?: string; toolCallId?: string; toolName?: string
}
type ToolCall = { name: string; arguments: Record<string, unknown> }
type StackItem = [node: SessionTreeNode, indent: number, justBranched: boolean, showConnector: boolean, isLast: boolean, gutters: Gutter[], isVirtualRootChild: boolean]

const messageOf = (entry: SessionEntry): Message | undefined => entry.type === 'message' ? entry.message as unknown as Message : undefined

function fullContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let result = ''
  for (const block of content) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') result += String((block as { text?: unknown }).text ?? '')
  }
  return result
}

const content200 = (content: unknown) => fullContent(content).slice(0, 200)

function hasText(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some(block => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text' && String((block as { text?: unknown }).text ?? '').trim().length > 0)
}

const shorten = (path: string) => {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

/** A tool call in one short bracketed phrase, such as `[read: ~/project/a.ts:10-40]`. */
export function formatToolCall(name: string, args: Record<string, unknown>): string {
  const path = () => shorten(String(args.path || args.file_path || ''))
  switch (name) {
    case 'read': {
      const { offset, limit } = args as { offset?: number; limit?: number }
      let display = path()
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1
        const end = limit !== undefined ? start + limit - 1 : ''
        display += `:${start}${end ? `-${end}` : ''}`
      }
      return `[read: ${display}]`
    }
    case 'write': return `[write: ${path()}]`
    case 'edit': return `[edit: ${path()}]`
    case 'bash': {
      const raw = String(args.command || '')
      return `[bash: ${raw.replace(/[\n\t]/g, ' ').trim().slice(0, 50)}${raw.length > 50 ? '...' : ''}]`
    }
    case 'grep': return `[grep: /${String(args.pattern || '')}/ in ${shorten(String(args.path || '.'))}]`
    case 'find': return `[find: ${String(args.pattern || '')} in ${shorten(String(args.path || '.'))}]`
    case 'ls': return `[ls: ${shorten(String(args.path || '.'))}]`
    default: {
      const json = JSON.stringify(args)
      return `[${name}: ${json.slice(0, 40)}${json.length > 40 ? '...' : ''}]`
    }
  }
}

/** How one entry reads in a row: a lead word, its text, and which color family it belongs to. */
export interface EntryText {
  lead: string
  leadTone: 'accent' | 'success' | 'muted' | 'dim' | 'warning' | 'error' | 'borderAccent' | 'customMessageLabel'
  text: string
  textTone?: 'muted' | 'dim' | 'error'
}

export class TreeModel {
  private flat: FlatNode[]
  private filtered: FlatNode[] = []
  private selectedIndexValue = 0
  private lastSelectedId: string | null = null
  private multipleRoots: boolean
  private activePath = new Set<string>()
  private visibleParent = new Map<string, string | null>()
  private visibleChildren = new Map<string | null, string[]>()
  private folded = new Set<string>()
  private toolCalls = new Map<string, ToolCall>()
  private query = ''
  private mode: TreeFilterMode
  showLabelTimestamps = false

  constructor(tree: SessionTreeNode[], private readonly currentLeafId: string | null, initialSelectedId?: string | null, initialFilterMode: TreeFilterMode = 'default') {
    this.mode = initialFilterMode
    this.multipleRoots = tree.length > 1
    this.flat = this.flatten(tree)
    this.buildActivePath()
    this.applyFilter()
    this.selectedIndexValue = this.nearestVisibleIndex(initialSelectedId ?? currentLeafId)
    this.lastSelectedId = this.filtered[this.selectedIndexValue]?.node.entry.id ?? null
  }

  get rows(): readonly FlatNode[] { return this.filtered }
  get selectedIndex(): number { return this.selectedIndexValue }
  get selectedNode(): SessionTreeNode | undefined { return this.filtered[this.selectedIndexValue]?.node }
  get filterMode(): TreeFilterMode { return this.mode }
  get searchQuery(): string { return this.query }
  get roots(): boolean { return this.multipleRoots }
  isFolded(id: string): boolean { return this.folded.has(id) }
  isOnActivePath(id: string): boolean { return this.activePath.has(id) }

  private entryMap(): Map<string, FlatNode> { return new Map(this.flat.map(item => [item.node.entry.id, item])) }

  /** The row for an entry, or the nearest visible ancestor when a filter hides it. */
  private nearestVisibleIndex(entryId: string | null | undefined): number {
    if (!this.filtered.length) return 0
    const entries = this.entryMap()
    const visible = new Map(this.filtered.map((item, index) => [item.node.entry.id, index]))
    let current: string | null = entryId ?? null
    while (current !== null) {
      const index = visible.get(current)
      if (index !== undefined) return index
      const item = entries.get(current)
      if (!item) break
      current = item.node.entry.parentId ?? null
    }
    return this.filtered.length - 1
  }

  private buildActivePath(): void {
    this.activePath.clear()
    const entries = this.entryMap()
    let current: string | null = this.currentLeafId
    while (current) {
      this.activePath.add(current)
      const item = entries.get(current)
      if (!item) break
      current = item.node.entry.parentId ?? null
    }
  }

  private flatten(roots: SessionTreeNode[]): FlatNode[] {
    const result: FlatNode[] = []
    this.toolCalls.clear()
    const containsActive = new Map<SessionTreeNode, boolean>()
    const leafId = this.currentLeafId
    const all: SessionTreeNode[] = []
    const pre = [...roots]
    while (pre.length) {
      const node = pre.pop()!
      all.push(node)
      for (let i = node.children.length - 1; i >= 0; i--) pre.push(node.children[i]!)
    }
    for (let i = all.length - 1; i >= 0; i--) {
      const node = all[i]!
      let has = leafId !== null && node.entry.id === leafId
      for (const child of node.children) if (containsActive.get(child)) has = true
      containsActive.set(node, has)
    }
    const multipleRoots = roots.length > 1
    const ordered = [...roots].sort((a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)))
    const stack: StackItem[] = []
    for (let i = ordered.length - 1; i >= 0; i--) stack.push([ordered[i]!, multipleRoots ? 1 : 0, multipleRoots, multipleRoots, i === ordered.length - 1, [], multipleRoots])
    while (stack.length) {
      const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!
      const message = messageOf(node.entry)
      if (message?.role === 'assistant' && Array.isArray(message.content)) {
        for (const block of message.content) {
          const call = block as { type?: unknown; id?: string; name?: string; arguments?: Record<string, unknown> }
          if (call && call.type === 'toolCall' && call.id) this.toolCalls.set(call.id, { name: call.name ?? 'tool', arguments: call.arguments ?? {} })
        }
      }
      result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild })
      const children = node.children
      const multipleChildren = children.length > 1
      const ordered = [...children.filter(child => containsActive.get(child)), ...children.filter(child => !containsActive.get(child))]
      const childIndent = multipleChildren ? indent + 1 : justBranched && indent > 0 ? indent + 1 : indent
      const displayed = showConnector && !isVirtualRootChild
      const position = Math.max(0, (this.multipleRoots ? Math.max(0, indent - 1) : indent) - 1)
      const childGutters = displayed ? [...gutters, { position, show: !isLast }] : gutters
      for (let i = ordered.length - 1; i >= 0; i--) stack.push([ordered[i]!, childIndent, multipleChildren, multipleChildren, i === ordered.length - 1, childGutters, false])
    }
    return result
  }

  private isSettingsEntry(entry: SessionEntry): boolean {
    return entry.type === 'label' || entry.type === 'context_edit' || entry.type === 'custom' || entry.type === 'model_change' || entry.type === 'thinking_level_change' || entry.type === 'session_info'
  }

  private applyFilter(): void {
    if (this.filtered.length > 0) this.lastSelectedId = this.filtered[this.selectedIndexValue]?.node.entry.id ?? this.lastSelectedId
    const tokens = this.query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
    this.filtered = this.flat.filter(item => {
      const entry = item.node.entry
      if (entry.type === 'usage') return false
      const message = messageOf(entry)
      // An assistant turn that only called tools reads as noise, unless it failed or is where the session stands.
      if (message?.role === 'assistant' && entry.id !== this.currentLeafId) {
        const failed = message.stopReason && message.stopReason !== 'stop' && message.stopReason !== 'toolUse'
        if (!hasText(message.content) && !failed) return false
      }
      const settings = this.isSettingsEntry(entry)
      let passes: boolean
      switch (this.mode) {
        case 'user-only': passes = message?.role === 'user'; break
        case 'no-tools': passes = !settings && message?.role !== 'toolResult'; break
        case 'labeled-only': passes = item.node.label !== undefined; break
        case 'all': passes = true; break
        default: passes = !settings
      }
      if (!passes) return false
      if (tokens.length) {
        const words = this.searchableText(item.node).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
        return tokens.every(token => words.some(word => token.length === 1 ? word === token : word.includes(token)))
      }
      return true
    })
    if (this.folded.size) {
      const skip = new Set<string>()
      for (const item of this.flat) {
        const { id, parentId } = item.node.entry
        if (parentId != null && (this.folded.has(parentId) || skip.has(parentId))) skip.add(id)
      }
      this.filtered = this.filtered.filter(item => !skip.has(item.node.entry.id))
    }
    this.recalculateVisualStructure()
    if (this.lastSelectedId) this.selectedIndexValue = this.nearestVisibleIndex(this.lastSelectedId)
    else if (this.selectedIndexValue >= this.filtered.length) this.selectedIndexValue = Math.max(0, this.filtered.length - 1)
    if (this.filtered.length > 0) this.lastSelectedId = this.filtered[this.selectedIndexValue]?.node.entry.id ?? this.lastSelectedId
  }

  /** Hiding entries re-attaches their descendants to the nearest visible ancestor, so the connectors are drawn again. */
  private recalculateVisualStructure(): void {
    if (!this.filtered.length) return
    const visibleIds = new Set(this.filtered.map(item => item.node.entry.id))
    const entries = this.entryMap()
    const ancestor = (id: string): string | null => {
      let current = entries.get(id)?.node.entry.parentId ?? null
      while (current !== null) {
        if (visibleIds.has(current)) return current
        current = entries.get(current)?.node.entry.parentId ?? null
      }
      return null
    }
    const parents = new Map<string, string | null>()
    const children = new Map<string | null, string[]>([[null, []]])
    for (const item of this.filtered) {
      const id = item.node.entry.id
      const parent = ancestor(id)
      parents.set(id, parent)
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent)!.push(id)
    }
    const rootIds = children.get(null)!
    this.multipleRoots = rootIds.length > 1
    const byId = new Map(this.filtered.map(item => [item.node.entry.id, item]))
    const stack: Array<[string, number, boolean, boolean, boolean, Gutter[], boolean]> = []
    for (let i = rootIds.length - 1; i >= 0; i--) stack.push([rootIds[i]!, this.multipleRoots ? 1 : 0, this.multipleRoots, this.multipleRoots, i === rootIds.length - 1, [], this.multipleRoots])
    while (stack.length) {
      const [id, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!
      const item = byId.get(id)
      if (!item) continue
      Object.assign(item, { indent, showConnector, isLast, gutters, isVirtualRootChild })
      const visible = children.get(id) ?? []
      const multipleChildren = visible.length > 1
      const childIndent = multipleChildren ? indent + 1 : justBranched && indent > 0 ? indent + 1 : indent
      const displayed = showConnector && !isVirtualRootChild
      const position = Math.max(0, (this.multipleRoots ? Math.max(0, indent - 1) : indent) - 1)
      const childGutters = displayed ? [...gutters, { position, show: !isLast }] : gutters
      for (let i = visible.length - 1; i >= 0; i--) stack.push([visible[i]!, childIndent, multipleChildren, multipleChildren, i === visible.length - 1, childGutters, false])
    }
    this.visibleParent = parents
    this.visibleChildren = children
  }

  private searchableText(node: SessionTreeNode): string {
    const entry = node.entry
    const parts: string[] = []
    if (node.label) parts.push(node.label)
    const message = messageOf(entry)
    if (message) {
      parts.push(message.role ?? '')
      if (message.content) parts.push(content200(message.content))
      if (message.role === 'bashExecution' && message.command) parts.push(message.command)
    } else switch (entry.type) {
      case 'custom_message': parts.push(entry.customType, typeof entry.content === 'string' ? entry.content : content200(entry.content)); break
      case 'compaction': parts.push('compaction'); break
      case 'branch_summary': parts.push('branch summary', entry.summary); break
      case 'session_info': parts.push('title'); if (entry.name) parts.push(entry.name); break
      case 'model_change': parts.push('model', entry.modelId); break
      case 'thinking_level_change': parts.push('thinking', entry.thinkingLevel); break
      case 'custom': parts.push('custom', entry.customType); break
      case 'context_edit': parts.push('context edit', entry.replacement === null ? 'omit' : 'replace', entry.targetId); break
      case 'label': parts.push('label', entry.label ?? ''); break
    }
    return parts.join(' ')
  }

  // ---- Changes ----------------------------------------------------------------------------

  setSearch(query: string): void {
    this.query = query
    this.folded.clear()
    this.applyFilter()
  }

  setFilter(mode: TreeFilterMode): void {
    this.mode = mode
    this.folded.clear()
    this.applyFilter()
  }

  /** Turns a filter on, or back to the default when it is already the one showing. */
  toggleFilter(mode: TreeFilterMode): void { this.setFilter(this.mode === mode ? 'default' : mode) }

  cycleFilter(direction: 1 | -1): void {
    const at = TREE_FILTER_MODES.indexOf(this.mode)
    this.setFilter(TREE_FILTER_MODES[(at + direction + TREE_FILTER_MODES.length) % TREE_FILTER_MODES.length]!)
  }

  move(delta: number, wrap = false): void {
    const count = this.filtered.length
    if (!count) return
    this.selectedIndexValue = wrap ? (this.selectedIndexValue + delta + count) % count : Math.max(0, Math.min(count - 1, this.selectedIndexValue + delta))
    this.lastSelectedId = this.filtered[this.selectedIndexValue]?.node.entry.id ?? this.lastSelectedId
  }

  /** Folds a foldable branch, or jumps to the start of the branch segment above. */
  foldOrUp(): void {
    const id = this.filtered[this.selectedIndexValue]?.node.entry.id
    if (id && this.isFoldable(id) && !this.folded.has(id)) { this.folded.add(id); this.applyFilter() }
    else this.jump(this.branchSegmentStart('up'))
  }

  /** Unfolds a folded branch, or jumps to the next branch point below. */
  unfoldOrDown(): void {
    const id = this.filtered[this.selectedIndexValue]?.node.entry.id
    if (id && this.folded.has(id)) { this.folded.delete(id); this.applyFilter() }
    else this.jump(this.branchSegmentStart('down'))
  }

  private jump(index: number): void {
    this.selectedIndexValue = index
    this.lastSelectedId = this.filtered[index]?.node.entry.id ?? this.lastSelectedId
  }

  /** A node can be folded when it has visible children and is a root or the start of a branch segment. */
  isFoldable(id: string): boolean {
    const children = this.visibleChildren.get(id)
    if (!children?.length) return false
    const parent = this.visibleParent.get(id)
    if (parent === null || parent === undefined) return true
    const siblings = this.visibleChildren.get(parent)
    return siblings !== undefined && siblings.length > 1
  }

  private branchSegmentStart(direction: 'up' | 'down'): number {
    const selected = this.filtered[this.selectedIndexValue]?.node.entry.id
    if (!selected) return this.selectedIndexValue
    const index = new Map(this.filtered.map((item, i) => [item.node.entry.id, i]))
    let current = selected
    if (direction === 'down') {
      for (;;) {
        const children = this.visibleChildren.get(current) ?? []
        if (!children.length) return index.get(current)!
        if (children.length > 1) return index.get(children[0]!)!
        current = children[0]!
      }
    }
    for (;;) {
      const parent = this.visibleParent.get(current) ?? null
      if (parent === null) return index.get(current)!
      const siblings = this.visibleChildren.get(parent) ?? []
      if (siblings.length > 1) {
        const start = index.get(current)!
        if (start < this.selectedIndexValue) return start
      }
      current = parent
    }
  }

  setLabel(entryId: string, label: string | undefined): void {
    const item = this.flat.find(candidate => candidate.node.entry.id === entryId)
    if (!item) return
    item.node.label = label
    item.node.labelTimestamp = label ? new Date().toISOString() : undefined
    this.applyFilter()
  }

  // ---- Reading ----------------------------------------------------------------------------

  /** The text `Ctrl+X` copies for the selected row, or nothing when it has none. */
  copyText(node = this.selectedNode): string | undefined {
    if (!node) return undefined
    const entry = node.entry
    let text: string | undefined
    const message = messageOf(entry)
    if (message) {
      if (message.role === 'bashExecution') text = message.command
      else if ('content' in message) {
        text = fullContent(message.content)
        if (!text && message.role === 'assistant') text = message.errorMessage
      }
    } else if (entry.type === 'custom_message') text = fullContent(entry.content)
    else if (entry.type === 'compaction' || entry.type === 'branch_summary') text = entry.summary
    return text?.trim() ? text : undefined
  }

  /** How an entry reads in its row. */
  describe(node: SessionTreeNode): EntryText {
    const entry = node.entry
    const flat = (value: string) => value.replace(/[\n\t]/g, ' ').trim()
    const message = messageOf(entry)
    if (message) {
      if (message.role === 'user') return { lead: 'user: ', leadTone: 'accent', text: flat(content200(message.content)) }
      if (message.role === 'assistant') {
        const text = flat(content200(message.content))
        if (text) return { lead: 'assistant: ', leadTone: 'success', text }
        if (message.stopReason === 'aborted') return { lead: 'assistant: ', leadTone: 'success', text: '(aborted)', textTone: 'muted' }
        if (message.errorMessage) return { lead: 'assistant: ', leadTone: 'success', text: flat(message.errorMessage).slice(0, 80), textTone: 'error' }
        return { lead: 'assistant: ', leadTone: 'success', text: '(no content)', textTone: 'muted' }
      }
      if (message.role === 'toolResult') {
        const call = message.toolCallId ? this.toolCalls.get(message.toolCallId) : undefined
        return { lead: '', leadTone: 'muted', text: call ? formatToolCall(call.name, call.arguments) : `[${message.toolName ?? 'tool'}]`, textTone: 'muted' }
      }
      if (message.role === 'bashExecution') return { lead: '', leadTone: 'dim', text: `[bash]: ${flat(message.command ?? '')}`, textTone: 'dim' }
      return { lead: '', leadTone: 'dim', text: `[${message.role}]`, textTone: 'dim' }
    }
    switch (entry.type) {
      case 'custom_message': return { lead: `[${entry.customType}]: `, leadTone: 'customMessageLabel', text: flat(typeof entry.content === 'string' ? entry.content : fullContent(entry.content)) }
      case 'compaction': return { lead: '', leadTone: 'borderAccent', text: `[compaction: ${Math.round(entry.tokensBefore / 1000)}k tokens]` }
      case 'branch_summary': return { lead: '[branch summary]: ', leadTone: 'warning', text: flat(entry.summary) }
      case 'model_change': return { lead: '', leadTone: 'dim', text: `[model: ${entry.modelId}]`, textTone: 'dim' }
      case 'thinking_level_change': return { lead: '', leadTone: 'dim', text: `[thinking: ${entry.thinkingLevel}]`, textTone: 'dim' }
      case 'custom': return { lead: '', leadTone: 'dim', text: `[custom: ${entry.customType}]`, textTone: 'dim' }
      case 'context_edit': return { lead: '', leadTone: 'dim', text: `[context ${entry.replacement === null ? 'omit' : 'replace'}: ${entry.targetId}]`, textTone: 'dim' }
      case 'label': return { lead: '', leadTone: 'dim', text: `[label: ${entry.label ?? '(cleared)'}]`, textTone: 'dim' }
      case 'session_info': return { lead: '', leadTone: 'dim', text: `[title: ${entry.name || 'empty'}]`, textTone: 'dim' }
      default: return { lead: '', leadTone: 'dim', text: '' }
    }
  }
}
