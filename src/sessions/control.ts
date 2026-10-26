// Session commands that need no model: read the branch tree, move to another branch, fork, clone,
// name, copy the last reply, and export to JSONL. They act on the saved native history directly,
// so a host that opens one Pi session per turn offers the same commands as the terminal.
// Compacting, navigating with a summary and exporting to HTML need a live session: they run as a
// session command through `sessions.run` (see `SessionCommand`).
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'

import { SessionManager, type SessionEntry, type SessionTreeNode } from '@earendil-works/pi-coding-agent'

import { invalid, notFound } from '../core/errors'
import { sessionFile as newestSessionFile } from '../prompt/compile'

/** Which saved history a command acts on: one file in the folder, or the newest there. */
export interface SessionRef {
  sessionDir: string
  sessionFile?: string | null
  /** Recorded in a new history's header. Defaults to the source history's own folder. */
  cwd?: string | null
}

export interface SessionTreeEntry {
  id: string
  parentId: string | null
  type: string
  /** `user`, `assistant`, `toolResult`, ... for a message entry. */
  role?: string
  /** One line of what the entry says, at most 160 characters. */
  text: string
  label?: string
  timestamp: string
  /** How deep in the tree, for indentation. */
  depth: number
}

export interface SessionTree {
  sessionFile: string
  leafId: string | null
  entries: SessionTreeEntry[]
  /** The person's messages on the current branch, newest last: where `/fork` may start. */
  forkPoints: { entryId: string; text: string }[]
}

/** A move without a summary is saved as this entry, so the next turn opens on the chosen branch. */
export const NAVIGATION_ENTRY = 'xingular-navigation'

function within(dir: string, file: string): boolean {
  const path = relative(realpathSync(dir), realpathSync(file))
  return !path.startsWith('..') && !isAbsolute(path)
}

function resolveFile(ref: SessionRef): string {
  if (!ref.sessionDir || !existsSync(ref.sessionDir)) throw notFound('This conversation has no saved history yet.')
  const file = ref.sessionFile ?? newestSessionFile(ref.sessionDir)
  if (!file || !existsSync(file)) throw notFound('This conversation has no saved history yet.')
  if (!file.endsWith('.jsonl') || !within(ref.sessionDir, file)) throw invalid('The history must be a .jsonl file in the session folder.')
  return realpathSync(file)
}

function open(ref: SessionRef, targetDir?: string): { manager: SessionManager; file: string } {
  const file = resolveFile(ref)
  return { manager: SessionManager.open(file, targetDir ?? ref.sessionDir, ref.cwd ?? undefined), file }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => part && typeof part === 'object' && (part as { type?: string }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : '').join(' ')
}

function entryText(entry: SessionEntry): { role?: string; text: string } {
  const record = entry as unknown as Record<string, unknown>
  if (entry.type === 'message') {
    const message = record.message as { role?: string; content?: unknown } | undefined
    return { role: message?.role, text: contentText(message?.content) }
  }
  if (entry.type === 'branch_summary' || entry.type === 'compaction') return { text: String(record.summary ?? '') }
  if (entry.type === 'session_info') return { text: String(record.name ?? '') }
  if (entry.type === 'model_change') return { text: `${record.provider ?? ''}/${record.modelId ?? ''}` }
  return { text: '' }
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 160)

function flatten(nodes: readonly SessionTreeNode[], depth: number, out: SessionTreeEntry[]): void {
  for (const node of nodes) {
    const entry = node.entry
    const { role, text } = entryText(entry)
    if (entry.type === 'custom' || entry.type === 'label') {
      flatten(node.children, depth, out)
      continue
    }
    out.push({
      id: entry.id,
      parentId: entry.parentId ?? null,
      type: entry.type,
      ...(role ? { role } : {}),
      text: oneLine(text),
      ...(node.label ? { label: node.label } : {}),
      timestamp: entry.timestamp,
      depth
    })
    flatten(node.children, node.children.length > 1 ? depth + 1 : depth, out)
  }
}

export function tree(ref: SessionRef): SessionTree {
  const { manager, file } = open(ref)
  const entries: SessionTreeEntry[] = []
  flatten(manager.getTree(), 0, entries)
  const forkPoints = manager.getBranch()
    .filter((entry) => entry.type === 'message' && entryText(entry).role === 'user')
    .map((entry) => ({ entryId: entry.id, text: oneLine(entryText(entry).text) }))
  return { sessionFile: file, leafId: manager.getLeafId(), entries, forkPoints }
}

/**
 * Moves the conversation to another entry without a summary. Choosing one of the person's
 * messages goes to just before it and gives its text back to edit, as the terminal does.
 */
export function navigate(ref: SessionRef & { entryId: string }): { leafId: string | null; editorText?: string } {
  const { manager } = open(ref)
  const entry = manager.getEntry(ref.entryId)
  if (!entry) throw notFound(`No entry ${ref.entryId} in this conversation.`)
  const { role, text } = entryText(entry)
  const userMessage = entry.type === 'message' && role === 'user'
  const target = userMessage ? entry.parentId ?? null : entry.id
  if (target) manager.branch(target)
  else manager.resetLeaf()
  manager.appendCustomEntry(NAVIGATION_ENTRY, { to: target })
  return { leafId: target, ...(userMessage ? { editorText: text } : {}) }
}

/** A new history in `targetDir` that ends just before one of the person's messages. */
export function fork(ref: SessionRef & { entryId: string; targetDir: string }): { sessionFile: string; editorText: string } {
  const { manager } = open(ref, ensureDir(ref.targetDir))
  const entry = manager.getEntry(ref.entryId)
  const { role, text } = entry ? entryText(entry) : { text: '' }
  if (!entry || entry.type !== 'message' || role !== 'user') throw invalid('Fork from one of your messages.')
  const sessionFile = entry.parentId
    ? manager.createBranchedSession(entry.parentId)
    : SessionManager.create(manager.getCwd(), ref.targetDir).getSessionFile()
  if (!sessionFile) throw invalid('The fork could not be saved.')
  return { sessionFile, editorText: text }
}

/** A new history in `targetDir` with the whole current branch. */
export function clone(ref: SessionRef & { targetDir: string }): { sessionFile: string } {
  const { manager } = open(ref, ensureDir(ref.targetDir))
  const leaf = manager.getLeafId()
  if (!leaf) throw invalid('Nothing to clone yet.')
  const sessionFile = manager.createBranchedSession(leaf)
  if (!sessionFile) throw invalid('The clone could not be saved.')
  return { sessionFile }
}

export function rename(ref: SessionRef & { name: string }): { name: string } {
  const name = ref.name.trim()
  if (!name) throw invalid('A session name cannot be empty.')
  open(ref).manager.appendSessionInfo(name)
  return { name }
}

/** The text of the last reply on the current branch, or null before the first. */
export function lastReply(ref: SessionRef): { text: string | null } {
  const branch = open(ref).manager.getBranch()
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const { role, text } = entryText(branch[index]!)
    if (branch[index]!.type === 'message' && role === 'assistant' && text.trim()) return { text: text.trim() }
  }
  return { text: null }
}

/** Writes the current branch as JSONL. HTML needs a live session: see `SessionCommand`. */
export function exportJsonl(ref: SessionRef & { path: string }): { path: string } {
  if (!isAbsolute(ref.path) || !ref.path.endsWith('.jsonl')) throw invalid('Export to an absolute .jsonl path.')
  const { manager } = open(ref)
  const lines = [manager.getHeader(), ...manager.getBranch()].filter(Boolean).map((entry) => JSON.stringify(entry))
  writeFileSync(ref.path, `${lines.join('\n')}\n`, 'utf8')
  return { path: ref.path }
}

function ensureDir(dir: string): string {
  if (!isAbsolute(dir)) throw invalid('The new history folder must be an absolute path.')
  mkdirSync(dir, { recursive: true })
  return dir
}

