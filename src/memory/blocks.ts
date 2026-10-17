// Core memory: blocks. A block is a short Markdown file that is always in the context of what
// it is attached to, and that the model edits itself. Blocks live under `wiki/blocks/`:
// `shared/<label>.md` (the `user` block and custom shared blocks), `agents/<agent-id>/` (an
// agent's `persona` and `notes`), and `projects/<slug>/brief.md`. A block's id and scope come
// from where its file lives. Every edit is a revision and an undoable operation.
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { noteChange } from '../core/changes'
import { HarnessError, invalid, notFound } from '../core/errors'
import * as frontmatter from '../core/frontmatter'
import { atomicWrite, newId, now, safeId, writeJson } from '../core/fs'
import { listProjects, projectsOrNone } from '../core/projects'
import { charCount, comparePaths, compareText } from '../core/text'
import { listOperations, undo, type Operation } from './operations'
import { looksSecret } from './secrets'
import * as store from './store'

export const DEFAULT_LIMIT = 2000
export const PROJECT_LIMIT = 3000
export const MAX_LIMIT = 20_000
/** An agent's prompt carries at most this many project briefs; the rest are listed by name. */
export const AGENT_PROJECT_BRIEFS = 2
const AGENT_LABELS = ['persona', 'notes']

export interface BlockFront {
  label: string
  /** Tells the model what belongs in the block. */
  description: string
  limit: number
  /** Only the user may edit it. */
  readOnly: boolean
  /** Custom shared blocks: the agents it is attached to; empty means every agent. */
  agents: string[]
  updatedAt: string
}

export type BlockScope = 'shared' | 'agent' | 'project'

export interface Block {
  /** `blocks/shared/user`, `blocks/agents/<agent-id>/persona`, `blocks/projects/<slug>/brief`. */
  id: string
  scope: BlockScope
  /** The agent id or project slug the block belongs to. */
  owner: string | null
  front: BlockFront
  body: string
  path: string
}

/** Who is reading or editing blocks. */
export type Caller =
  | { kind: 'user' }
  /** An agent with blocks of its own, and the name recorded on its revisions. */
  | { kind: 'agent'; id: string; name: string; vaultAccess?: 'self' | 'propose' | 'curator' }
  /** A session without blocks of its own, and its project, if any. */
  | { kind: 'session'; projectSlug: string | null }

function actorOf(caller: Caller): string {
  return caller.kind === 'user' ? 'user' : caller.kind === 'agent' ? caller.name : 'Harness session'
}

export function blocksDir(wiki: string): string {
  return join(wiki, 'blocks')
}

function locate(wiki: string, path: string): { id: string; scope: BlockScope; owner: string | null } | null {
  const inside = relative(blocksDir(wiki), path)
  if (inside.startsWith('..')) return null
  const parts = inside.replace(/(?<=[^/])\.[^./]*$/, '').split('/')
  const id = `blocks/${parts.join('/')}`
  if (parts.length === 2 && parts[0] === 'shared') return { id, scope: 'shared', owner: null }
  if (parts.length === 3 && parts[0] === 'agents') return { id, scope: 'agent', owner: parts[1] }
  if (parts.length === 3 && parts[0] === 'projects' && parts[2] === 'brief') return { id, scope: 'project', owner: parts[1] }
  return null
}

export function parseFront(front: Record<string, unknown>): BlockFront | null {
  const { label, description, limit, readOnly, updatedAt } = front
  if (typeof label !== 'string') return null
  if (description !== undefined && typeof description !== 'string') return null
  if (limit !== undefined && !(typeof limit === 'number' && Number.isInteger(limit) && limit >= 0)) return null
  if (readOnly !== undefined && typeof readOnly !== 'boolean') return null
  if (updatedAt !== undefined && typeof updatedAt !== 'string') return null
  const agents = store.stringList(front.agents)
  if (!agents) return null
  return { label, description: description ?? '', limit: limit ?? DEFAULT_LIMIT, readOnly: readOnly ?? false, agents, updatedAt: updatedAt ?? '' }
}

export function serializeBlock(front: BlockFront, body: string): string {
  return frontmatter.serialize(
    { label: front.label, description: front.description, limit: front.limit, readOnly: front.readOnly, ...(front.agents.length ? { agents: front.agents } : {}), updatedAt: front.updatedAt },
    body
  )
}

function parse(wiki: string, path: string): Block | null {
  const located = locate(wiki, path)
  if (!located) return null
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const parsed = frontmatter.parse(text)
  const front = parsed && parseFront(parsed.front)
  if (!parsed || !front) return null
  return { ...located, front, body: parsed.body.trimEnd(), path }
}

export function loadAll(wiki: string): Block[] {
  const files: string[] = []
  store.markdownFiles(blocksDir(wiki), files)
  return files.sort(comparePaths).flatMap((path) => parse(wiki, path) ?? [])
}

/** A block by its id (`blocks/shared/user`). Every segment must be a safe identifier. */
export function find(wiki: string, id: string): Block {
  if (!id.startsWith('blocks/')) throw notFound('Memory block')
  const segments = id.slice('blocks/'.length).split('/')
  try {
    segments.forEach(safeId)
  } catch {
    throw notFound('Memory block')
  }
  const block = parse(wiki, `${join(blocksDir(wiki), ...segments)}.md`)
  if (!block) throw notFound('Memory block')
  return block
}

function create(wiki: string, path: string, label: string, description: string, limit: number): Block {
  const file = join(blocksDir(wiki), `${path}.md`)
  if (!existsSync(file)) atomicWrite(file, serializeBlock({ label, description, limit, readOnly: false, agents: [], updatedAt: now() }, ''))
  const block = parse(wiki, file)
  if (!block) throw new HarnessError('invalid_data', `The ${label} memory block could not be read.`)
  return block
}

export function ensureUser(wiki: string): Block {
  return create(wiki, 'shared/user', 'user', 'What you know about the user: name, role, preferences, and how they like to work. Shared with every agent and session.', DEFAULT_LIMIT)
}

export function ensureAgent(wiki: string, agentId: string): Block[] {
  const agent = safeId(agentId)
  return [
    create(wiki, `agents/${agent}/persona`, 'persona', 'How you work: your role for this user, your habits, and what you have learned about doing this job well.', DEFAULT_LIMIT),
    create(wiki, `agents/${agent}/notes`, 'notes', 'Working notes to keep across turns: what you are in the middle of and what to follow up. Prune what is done.', DEFAULT_LIMIT)
  ]
}

export function ensureProject(wiki: string, slug: string, name: string): Block {
  const safe = safeId(slug)
  return create(
    wiki,
    `projects/${safe}/brief`,
    `project/${safe}`,
    `What ${name.replaceAll('\n', ' ')} is, its stack and conventions, and its current state. Shared by everyone working in this project.`,
    PROJECT_LIMIT
  )
}

/**
 * The blocks in a caller's context, in the order they are shown. Missing default blocks are
 * created. `projectSlugs` are the projects whose briefs an agent carries (most recent first).
 */
export function attached(root: string, caller: Caller, projectSlugs: readonly string[]): Block[] {
  const wiki = store.wikiDir(root)
  const projectName = (slug: string): string | null => projectsOrNone(root).find((project) => project.slug === slug)?.name ?? null
  if (caller.kind === 'user') return loadAll(wiki)
  const blocks: Block[] = []
  if (caller.kind === 'agent') {
    blocks.push(...ensureAgent(wiki, caller.id))
    blocks.push(ensureUser(wiki))
    blocks.push(...loadAll(wiki).filter((block) => block.scope === 'shared' && block.front.label !== 'user' && (!block.front.agents.length || block.front.agents.includes(caller.id))))
    // The most recently active projects are chosen, then listed in a fixed order: later activity
    // must not reshuffle the context a prompt cache was built on.
    for (const slug of projectSlugs.slice(0, AGENT_PROJECT_BRIEFS).sort(compareText)) {
      const name = projectName(slug)
      if (name !== null) blocks.push(ensureProject(wiki, slug, name))
    }
  } else {
    blocks.push(ensureUser(wiki))
    const name = caller.projectSlug ? projectName(caller.projectSlug) : null
    if (caller.projectSlug && name !== null) blocks.push(ensureProject(wiki, caller.projectSlug, name))
  }
  return blocks
}

/** Why `caller` may not change `block`, or `null` when it may; the text is what the model sees. */
export function editRefusal(caller: Caller, block: Block): string | null {
  const label = block.front.label
  if (caller.kind === 'user') return null
  if (block.front.readOnly) return `The ${label} block is read-only; only the user can change it.`
  if (caller.kind === 'agent' && caller.vaultAccess === 'propose') return 'Memory changes are proposals in this session. Submit the block change with wiki_propose; the next memory merge applies it.'
  if (caller.kind === 'agent' && caller.vaultAccess === 'self' && (block.scope !== 'agent' || block.owner !== caller.id || !['persona', 'notes'].includes(label))) return 'This field is outside your writable memory. Submit a block change with wiki_propose for the curator to review.'
  if (caller.kind === 'agent') {
    if (block.scope === 'agent') return block.owner === caller.id ? null : 'That block belongs to another agent.'
    if (block.scope === 'shared') return !block.front.agents.length || block.front.agents.includes(caller.id) ? null : `The ${label} block is not attached to you.`
    return null
  }
  if (block.scope === 'project') return block.owner === caller.projectSlug ? null : "A session may edit only its own project's brief."
  return `A Harness session can read the ${label} block but cannot edit it. Report what you learned in your result instead.`
}

/**
 * Finds the block a caller means by `label`: `user`, `persona`, `notes`, `project/<slug>`
 * (or `project` for a session's own), a custom shared label, or a full block id.
 */
export function resolve(root: string, caller: Caller, rawLabel: string): Block {
  const wiki = store.wikiDir(root)
  const label = rawLabel.trim().replace(/^\/+/, '')
  const unknown = () => invalid(`There is no memory block called ${label}. Use one of the labels shown in your memory blocks.`)
  const orUnknown = (id: string): Block => {
    try {
      return find(wiki, id)
    } catch {
      throw unknown()
    }
  }
  if (label.startsWith('blocks/')) return orUnknown(label)
  if (AGENT_LABELS.includes(label)) {
    if (caller.kind !== 'agent') throw invalid(`The ${label} block belongs to an agent, not to a session.`)
    return ensureAgent(wiki, caller.id).find((block) => block.front.label === label)!
  }
  if (label === 'project' || label.startsWith('project/')) {
    const slug = label.startsWith('project/') ? label.slice('project/'.length) : caller.kind === 'session' ? caller.projectSlug : null
    if (slug === null) throw invalid('Name the project: project/<slug>.')
    const project = listProjects(root).find((entry) => entry.slug === slug)
    if (!project) throw unknown()
    return ensureProject(wiki, project.slug, project.name)
  }
  if (label === 'user') return ensureUser(wiki)
  return orUnknown(`blocks/shared/${label}`)
}

export type Edit = { kind: 'append'; text: string } | { kind: 'replace'; old: string; new: string } | { kind: 'rethink'; text: string }

/** The body after an edit. Pure, so the rules are testable. Throws the reason an edit is refused. */
export function applyEdit(body: string, edit: Edit): string {
  if (edit.kind === 'append') {
    const text = edit.text.trim()
    if (!text) throw invalid('Nothing to append.')
    return body.trim() ? `${body.trimEnd()}\n${text}` : text
  }
  if (edit.kind === 'replace') {
    if (!edit.old) throw invalid('Give the exact passage to replace.')
    const count = body.split(edit.old).length - 1
    if (count === 0) throw invalid('That passage is not in the block. Copy it exactly as it appears.')
    if (count > 1) throw invalid(`That passage appears ${count} times. Include more of the surrounding text so it is unique.`)
    return body.replace(edit.old, () => edit.new).trim()
  }
  return edit.text.trim()
}

/** Why `body` cannot be stored in the block, or `null`. */
export function check(front: BlockFront, body: string): string | null {
  const length = charCount(body)
  if (length > front.limit) {
    return `The ${front.label} block would be ${length} of ${front.limit} characters. Condense it with memory_rethink, or move detail to the Wiki with wiki_propose.`
  }
  if (looksSecret(body) || looksSecret(front.description)) return 'That text looks like it contains a credential, so it was not stored.'
  return null
}

/** Writes a block's new content with a revision before and after and an undo operation. */
function write(wiki: string, block: Block, front: BlockFront, body: string, actor: string, reason: string): Block {
  let current = ''
  try {
    current = readFileSync(block.path, 'utf8')
  } catch {
    current = ''
  }
  const next = serializeBlock(front, body)
  if (next === current) return block
  // The undo target: the latest revision when it already holds the current text, else a new one.
  const latest = store.currentRevision(wiki, block.id)
  let before: string | null = null
  if (latest) {
    try {
      if (store.revisionText(wiki, block.id, latest) === current) before = latest
    } catch {
      before = null
    }
  }
  before ??= store.snapshot(wiki, block.id, current, actor, 'Before edit').id
  atomicWrite(block.path, next)
  const after = store.snapshot(wiki, block.id, next, actor, reason)
  noteChange({ wiki, id: block.id, path: block.path, text: next, actor, reason })
  const operation: Operation = {
    id: newId(),
    createdAt: now(),
    trigger: `${actor}: ${reason} (${front.label})`,
    pages: [{ pageId: block.id, path: block.path, beforeRevisionId: before, afterRevisionId: after.id }],
    undone: false
  }
  writeJson(join(wiki, 'operations', `${operation.id}.json`), operation)
  store.log(wiki, `- ${now()} · ${actor} · block · \`${block.id}\` ${reason} · revision \`${after.id}\``)
  return find(wiki, block.id)
}

/** A model's edit through `memory_append`, `memory_replace`, or `memory_rethink`. */
export function edit(root: string, caller: Caller, label: string, change: Edit): Block {
  const wiki = store.wikiDir(root)
  const block = resolve(root, caller, label)
  const refusal = editRefusal(caller, block)
  if (refusal) throw invalid(refusal)
  const body = applyEdit(block.body, change)
  const problem = check(block.front, body)
  if (problem) throw invalid(problem)
  const reason = change.kind === 'append' ? 'appended' : change.kind === 'replace' ? 'replaced a passage' : 'rewrote'
  return write(wiki, block, { ...block.front, updatedAt: now() }, body, actorOf(caller), reason)
}

export interface BlockInput {
  /** An existing block id, or none to create a shared block from `label`. */
  id?: string | null
  label?: string | null
  body: string
  description: string
  limit: number
  readOnly?: boolean
  agents?: string[]
}

/** The user's edit in the Wiki, or a new custom shared block. */
export function saveAsUser(wiki: string, input: BlockInput): Block {
  if (!Number.isInteger(input.limit) || input.limit <= 0 || input.limit > MAX_LIMIT) throw invalid(`A block's limit is between 1 and ${MAX_LIMIT} characters.`)
  let block: Block
  if (input.id) {
    block = find(wiki, input.id)
  } else {
    const label = store.slug(input.label ?? '')
    if (!(input.label ?? '').trim() || AGENT_LABELS.includes(label) || label === 'user' || label.startsWith('project')) {
      throw invalid('Give the block a label that is not user, persona, notes, or project.')
    }
    let exists = true
    try {
      find(wiki, `blocks/shared/${label}`)
    } catch {
      exists = false
    }
    if (exists) throw invalid(`A shared block called ${label} already exists.`)
    block = create(wiki, `shared/${label}`, label, input.description.trim(), input.limit)
  }
  const front: BlockFront = { ...block.front, description: input.description.trim(), limit: input.limit, readOnly: input.readOnly ?? false, updatedAt: now() }
  if (block.scope === 'shared' && front.label !== 'user') front.agents = input.agents ?? []
  const body = input.body.trim()
  const problem = check(front, body)
  if (problem) throw invalid(problem)
  return write(wiki, block, front, body, 'user', input.id ? 'edited' : 'created')
}

/** The most recent edit of a block that has not been undone yet. */
function lastEdit(wiki: string, blockId: string): Operation | null {
  return (
    listOperations(wiki)
      .filter((operation) => !operation.undone && operation.pages.length === 1 && operation.pages[0].pageId === blockId)
      .sort((left, right) => compareText(left.createdAt, right.createdAt))
      .at(-1) ?? null
  )
}

export function undoLast(wiki: string, blockId: string): Block {
  const latest = lastEdit(wiki, blockId)
  if (!latest) throw invalid('There is no edit to undo.')
  undo(wiki, latest.id)
  return find(wiki, blockId)
}

/**
 * The memory-blocks section of a compiled prompt. `cli` names the `xagent-wiki` commands in
 * place of the tools, for sessions that have the command and not the tools.
 */
export function render(blocks: readonly Block[], caller: Caller, cli: boolean): string {
  if (!blocks.length) return ''
  const how = cli
    ? '`xagent-wiki block append <label> <text>`, `block replace <label> --old <text> --new <text>`, or `block rethink <label> <text>`'
    : 'memory_append, memory_replace, or memory_rethink'
  return `## Memory blocks\n\nThese blocks are your memory that is always in view, and they persist across conversations. When you learn something worth keeping, edit a block you may change with ${how}. Keep each block within its limit.\n${renderItems(blocks, caller)}`
}

/** The blocks alone, each framed with its label, how full it is, and what belongs in it. */
export function renderItems(blocks: readonly Block[], caller: Caller): string {
  let text = ''
  for (const block of blocks) {
    const editable = editRefusal(caller, block) === null
    text += `\n<block label="${block.front.label}" chars="${charCount(block.body)}/${block.front.limit}"${editable ? '' : ' read-only="true"'}>\n${block.front.description}\n---\n${block.body.trim() || '(empty)'}\n</block>\n`
  }
  return text
}

export type MemoryBlock = Omit<BlockFront, 'agents'> & { agents?: string[]; id: string; scope: BlockScope; owner: string | null; body: string; path: string; revisionId: string | null; canUndo: boolean }

export function response(wiki: string, block: Block): MemoryBlock {
  const { agents, ...front } = block.front
  return {
    id: block.id,
    scope: block.scope,
    owner: block.owner,
    ...front,
    ...(agents.length ? { agents } : {}),
    body: block.body,
    path: block.path,
    revisionId: store.currentRevision(wiki, block.id),
    canUndo: lastEdit(wiki, block.id) !== null
  }
}
