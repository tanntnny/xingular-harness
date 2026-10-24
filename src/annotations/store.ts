// Page notes (PROP-0017): what a person wrote about a whole web page, a quoted passage or an element
// of it. One JSON file per note under `<data root>/annotations/`, changed only with the version the
// caller last saw. A note is private until a person shares it with a session or an agent; the
// model can only read notes shared with it.
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { HarnessError, invalid, notFound } from '../core/errors'
import { newId, now, readJson, safeId, writeJson } from '../core/fs'

export const MAX_NOTES = 10_000
const MAX_HISTORY = 100

export interface NoteSource {
  url: string
  title: string
  capturedAt: string
  /** An opaque label of the front end that captured it (a host's tab, the terminal's browser). */
  surface?: string | null
  /** Untrusted document token at capture; a hint, never a content hash or a permission. */
  representationHint?: string | null
  /** Set when the note was captured in a desktop app's window rather than a web page (PROP-0018). */
  app?: NoteApp | null
}

/** A desktop app window a note was captured in: attached through its DevTools port, or a page bridge. */
export interface NoteApp {
  kind: 'cdp' | 'bridge'
  name: string
}

/**
 * Where a note stands on its way to an agent (PROP-0018). `queued` waits for the person to send it;
 * `sent` went to the session as part of a run; `fixed` is the agent's claim that it is done. Only a
 * person resolves a note.
 */
export interface NoteDelivery {
  state: 'queued' | 'sent' | 'fixed'
  sessionId: string
  queuedAt: string
  /** Send it as soon as the session is idle ("Proceed now" while the agent was still working). */
  autoSend?: boolean
  /** The person still has to confirm sending: it came from a page script the page could have forged. */
  confirm?: boolean
  sentAt?: string
  runId?: string
  fixedAt?: string
  /** The agent's own words on what it changed. */
  summary?: string
}

export type NoteTarget =
  | { kind: 'page' }
  | { kind: 'text'; exact: string; prefix: string; suffix: string; start: number; end: number }
  | { kind: 'element'; tag: string; role: string; name: string; text: string; context: string; selector: string }

/** Who may read a note through the model tools: a session, or an agent by its opaque id. */
export interface NotePrincipal {
  sessionId?: string
  agentId?: string
}

export interface NoteGrant {
  principal: NotePrincipal
  /** An opaque host string the host revokes with (for example a tab and its sharing epoch). */
  binding?: string | null
  grantedAt: string
}

export type NoteOperation = 'create' | 'import' | 'update' | 'share' | 'unshare' | 'revoke_binding' | 'queue' | 'dequeue' | 'deliver' | 'mark_fixed'

export interface Note {
  id: string
  version: number
  source: NoteSource
  target: NoteTarget
  body: string
  tags: string[]
  status: 'open' | 'resolved'
  author: 'user'
  createdAt: string
  updatedAt: string
  grants: NoteGrant[]
  delivery?: NoteDelivery | null
  history: { version: number; operation: NoteOperation; at: string }[]
}

export interface NoteInput {
  source: NoteSource
  target: NoteTarget
  body: string
  tags?: string[]
}

export interface NotePatch {
  body?: string
  tags?: string[]
  status?: 'open' | 'resolved'
  target?: NoteTarget
}

const codepoints = (value: string): number => Array.from(value).length

function bounded(value: unknown, max: number, required: boolean, field: string): string {
  if (typeof value !== 'string' || codepoints(value) > max || (required && !value.trim())) throw invalid(`Invalid note ${field}.`)
  return value
}

export function validateUrl(value: unknown): string {
  const text = bounded(value, 4096, true, 'URL')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw invalid('Invalid note URL.')
  }
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(text)?.[1] ?? null
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || authority === null || authority.includes('@') || /[\s\p{Cc}]/u.test(text)) {
    throw invalid('Note URLs must be HTTP(S) without credentials.')
  }
  return text
}

const APP_SCHEMES = new Set(['http:', 'https:', 'file:', 'app:', 'tauri:', 'electron:', 'asset:'])

/** An app window's address: web addresses, plus the local schemes desktop apps load from. Never credentials. */
export function validateAppUrl(value: unknown): string {
  const text = bounded(value, 4096, true, 'URL')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw invalid('Invalid note URL.')
  }
  if (!APP_SCHEMES.has(url.protocol) || url.username || url.password || /[\s\p{Cc}]/u.test(text)) throw invalid('An app note URL must be a web, file or app address without credentials.')
  return text
}

function validateApp(app: unknown): NoteApp | null {
  if (app == null) return null
  const value = app as Record<string, unknown>
  if (value.kind !== 'cdp' && value.kind !== 'bridge') throw invalid('A note app is attached through cdp or a bridge.')
  return { kind: value.kind, name: bounded(value.name, 200, true, 'app name') }
}

function validateSource(source: unknown): NoteSource {
  if (!source || typeof source !== 'object') throw invalid('A note needs its source page.')
  const value = source as Record<string, unknown>
  const app = validateApp(value.app)
  return {
    url: app ? validateAppUrl(value.url) : validateUrl(value.url),
    ...(app ? { app } : {}),
    title: bounded(value.title ?? '', 200, false, 'title'),
    capturedAt: typeof value.capturedAt === 'string' && value.capturedAt ? value.capturedAt : now(),
    ...(value.surface != null ? { surface: bounded(value.surface, 200, true, 'surface') } : {}),
    ...(value.representationHint != null ? { representationHint: bounded(value.representationHint, 128, true, 'representation hint') } : {})
  }
}

export function validateTarget(target: unknown): NoteTarget {
  if (!target || typeof target !== 'object') throw invalid('A note needs a target.')
  const value = target as Record<string, unknown>
  const keys = Object.keys(value).sort().join(',')
  if (value.kind === 'page') {
    if (keys !== 'kind') throw invalid('Invalid page target.')
    return { kind: 'page' }
  }
  if (value.kind === 'text') {
    if (keys !== 'end,exact,kind,prefix,start,suffix') throw invalid('Invalid text target.')
    const exact = bounded(value.exact, 4000, true, 'exact text')
    const prefix = bounded(value.prefix, 128, false, 'text prefix')
    const suffix = bounded(value.suffix, 128, false, 'text suffix')
    const start = value.start
    const end = value.end
    // Offsets count Unicode code points of the page's normalised text, not UTF-16 units.
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) <= (start as number) || (end as number) - (start as number) !== codepoints(exact)) {
      throw invalid('Note text offsets do not match the exact text.')
    }
    return { kind: 'text', exact, prefix, suffix, start: start as number, end: end as number }
  }
  if (value.kind === 'element') {
    if (keys !== 'context,kind,name,role,selector,tag,text') throw invalid('Invalid element target.')
    const element = {
      kind: 'element' as const,
      tag: bounded(value.tag, 40, true, 'element tag'),
      role: bounded(value.role, 80, false, 'element role'),
      name: bounded(value.name, 200, false, 'element name'),
      text: bounded(value.text, 500, false, 'element text'),
      context: bounded(value.context, 200, false, 'element context'),
      selector: bounded(value.selector, 500, false, 'element selector')
    }
    if (!element.name.trim() && !element.text.trim()) throw invalid('An element note needs a meaningful name or text.')
    return element
  }
  throw invalid('A note target is a page, text or an element.')
}

function normalizeBody(body: unknown): string {
  return bounded(typeof body === 'string' ? body.trim() : body, 10_000, true, 'body')
}

function normalizeTags(tags: unknown): string[] {
  if (tags === undefined) return []
  if (!Array.isArray(tags) || tags.length > 12) throw invalid('A note takes at most 12 tags.')
  return [...new Set(tags.map((tag) => bounded(typeof tag === 'string' ? tag.trim() : tag, 40, true, 'tag')))]
}

function validatePrincipal(principal: unknown): NotePrincipal {
  const value = (principal ?? {}) as Record<string, unknown>
  const result: NotePrincipal = {}
  if (typeof value.sessionId === 'string' && value.sessionId) result.sessionId = safeId(value.sessionId)
  if (typeof value.agentId === 'string' && value.agentId) result.agentId = safeId(value.agentId)
  if (!result.sessionId === !result.agentId) throw invalid('Share a note with exactly one session or one agent.')
  return result
}

const samePrincipal = (left: NotePrincipal, right: NotePrincipal): boolean => left.sessionId === right.sessionId && left.agentId === right.agentId

/** Whether a caller may read a note through the model tools. */
export function visibleTo(note: Note, caller: { sessionId?: string | null; agentId?: string | null }): boolean {
  return note.grants.some((grant) =>
    (grant.principal.sessionId && grant.principal.sessionId === caller.sessionId) ||
    (grant.principal.agentId && grant.principal.agentId === caller.agentId))
}

export function notesDir(root: string): string {
  return join(root, 'annotations')
}

function folder(root: string): string {
  const dir = notesDir(root)
  if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())) throw new HarnessError('invalid_data', 'Note storage must be a plain folder.')
  mkdirSync(dir, { recursive: true })
  return dir
}

function file(root: string, id: string): string {
  return join(folder(root), `${safeId(id)}.json`)
}

function validNote(note: Note | null, id: string): Note {
  if (!note || note.id !== id || note.author !== 'user' || !Number.isSafeInteger(note.version) || note.version < 1 || !Array.isArray(note.grants) || !Array.isArray(note.history)) {
    throw new HarnessError('invalid_data', `Note ${id} is not a valid note.`)
  }
  return note
}

export function read(root: string, id: string): Note {
  const path = file(root, id)
  if (!existsSync(path)) throw notFound('Note')
  if (lstatSync(path).isSymbolicLink()) throw new HarnessError('invalid_data', 'Note records must not be links.')
  return validNote(readJson<Note>(path), id)
}

function all(root: string): Note[] {
  const notes: Note[] = []
  for (const name of readdirSync(folder(root))) {
    if (!name.endsWith('.json')) continue
    try {
      notes.push(read(root, name.slice(0, -'.json'.length)))
    } catch {
      // A damaged file is skipped, never shown as a note.
    }
  }
  return notes
}

export interface NoteQuery {
  url?: string | null
  query?: string | null
  status?: 'open' | 'resolved' | null
  offset?: number
  limit?: number
}

function matchingNotes(root: string, filter: NoteQuery): Note[] {
  const query = filter.query?.trim().toLowerCase()
  return all(root)
    .filter((note) => !filter.url || note.source.url === filter.url)
    .filter((note) => !filter.status || note.status === filter.status)
    .filter((note) => !query || [note.body, note.source.title, note.source.url, ...note.tags, note.target.kind === 'text' ? note.target.exact : note.target.kind === 'element' ? note.target.name : ''].join('\n').toLowerCase().includes(query))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
}

/** All matching notes for internal consumers that paginate after applying their own visibility filter. */
export function listAll(root: string, filter: NoteQuery = {}): Note[] {
  return matchingNotes(root, filter)
}

export function list(root: string, filter: NoteQuery = {}): { notes: Note[]; total: number } {
  const matching = matchingNotes(root, filter)
  const offset = Math.max(0, Math.floor(filter.offset ?? 0))
  const limit = Math.max(1, Math.min(200, Math.floor(filter.limit ?? 50)))
  return { notes: matching.slice(offset, offset + limit), total: matching.length }
}

function save(root: string, note: Note, operation: NoteOperation): Note {
  note.version += 1
  note.updatedAt = now()
  note.history.push({ version: note.version, operation, at: note.updatedAt })
  if (note.history.length > MAX_HISTORY) note.history.splice(0, note.history.length - MAX_HISTORY)
  writeJson(file(root, note.id), note)
  return note
}

function current(root: string, id: string, expectedVersion: number | undefined): Note {
  const note = read(root, id)
  if (expectedVersion !== undefined && note.version !== expectedVersion) throw new HarnessError('version_conflict', 'The note changed. Read it again before saving.')
  return note
}

export function create(root: string, input: NoteInput): Note {
  const source = validateSource(input?.source)
  const target = validateTarget(input?.target)
  const body = normalizeBody(input?.body)
  const tags = normalizeTags(input?.tags)
  if (readdirSync(folder(root)).filter((name) => name.endsWith('.json')).length >= MAX_NOTES) {
    throw new HarnessError('annotation_limit', `At most ${MAX_NOTES} notes may be kept.`)
  }
  const at = now()
  const note: Note = { id: newId(), version: 1, source, target, body, tags, status: 'open', author: 'user', createdAt: at, updatedAt: at, grants: [], history: [{ version: 1, operation: 'create', at }] }
  writeJson(file(root, note.id), note)
  return note
}

export function update(root: string, id: string, expectedVersion: number, patch: NotePatch): Note {
  const note = current(root, id, expectedVersion)
  if (patch.body !== undefined) note.body = normalizeBody(patch.body)
  if (patch.tags !== undefined) note.tags = normalizeTags(patch.tags)
  if (patch.status !== undefined) {
    if (patch.status !== 'open' && patch.status !== 'resolved') throw invalid('A note is open or resolved.')
    note.status = patch.status
    if (patch.status === 'resolved' && note.delivery?.state === 'queued') note.delivery = null
  }
  if (patch.target !== undefined) note.target = validateTarget(patch.target)
  return save(root, note, 'update')
}

export function remove(root: string, id: string, expectedVersion: number): void {
  current(root, id, expectedVersion)
  rmSync(file(root, id))
}

/** A person lets one session or agent read the note through the model tools. */
export function share(root: string, id: string, principal: NotePrincipal, binding: string | null = null): Note {
  const who = validatePrincipal(principal)
  const note = current(root, id, undefined)
  note.grants = note.grants.filter((grant) => !samePrincipal(grant.principal, who))
  note.grants.push({ principal: who, ...(binding ? { binding: bounded(binding, 200, true, 'binding') } : {}), grantedAt: now() })
  return save(root, note, 'share')
}

export function unshare(root: string, id: string, principal: NotePrincipal): Note {
  const who = validatePrincipal(principal)
  const note = current(root, id, undefined)
  note.grants = note.grants.filter((grant) => !samePrincipal(grant.principal, who))
  return save(root, note, 'unshare')
}

/** The host withdrew what a binding stood for (a tab closed or was shared again): every grant made with it ends. */
export function revokeBinding(root: string, binding: string): number {
  bounded(binding, 200, true, 'binding')
  let changed = 0
  for (const note of all(root)) {
    if (!note.grants.some((grant) => grant.binding === binding)) continue
    note.grants = note.grants.filter((grant) => grant.binding !== binding)
    save(root, note, 'revoke_binding')
    changed += 1
  }
  return changed
}

/** Takes notes another store kept, keeping their ids. A note whose id exists is skipped. */
export function importNotes(root: string, notes: unknown[]): { imported: string[]; skipped: { id: string | null; reason: string }[] } {
  const imported: string[] = []
  const skipped: { id: string | null; reason: string }[] = []
  for (const raw of Array.isArray(notes) ? notes : []) {
    const value = (raw ?? {}) as Record<string, unknown>
    const id = typeof value.id === 'string' ? value.id : null
    try {
      if (!id) throw invalid('A note needs an id.')
      safeId(id)
      if (existsSync(file(root, id))) { skipped.push({ id, reason: 'exists' }); continue }
      const at = now()
      const note: Note = {
        id,
        version: 1,
        source: validateSource(value.source),
        target: validateTarget(value.target),
        body: normalizeBody(value.body),
        tags: normalizeTags(value.tags),
        status: value.status === 'resolved' ? 'resolved' : 'open',
        author: 'user',
        createdAt: typeof value.createdAt === 'string' ? value.createdAt : at,
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : at,
        grants: Array.isArray(value.grants) ? value.grants.map((grant) => {
          const entry = (grant ?? {}) as Record<string, unknown>
          return { principal: validatePrincipal(entry.principal), ...(typeof entry.binding === 'string' && entry.binding ? { binding: entry.binding } : {}), grantedAt: typeof entry.grantedAt === 'string' ? entry.grantedAt : at }
        }) : [],
        history: [{ version: 1, operation: 'import', at }]
      }
      writeJson(file(root, id), note)
      imported.push(id)
    } catch (error) {
      skipped.push({ id, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { imported, skipped }
}

// ---- Delivery to an agent (PROP-0018) ----------------------------------------------------------

/**
 * A person asks a session to act on the note: it is shared with that session (if it was not) and
 * waits in the session's queue until it is sent.
 */
export function queue(root: string, id: string, expectedVersion: number | undefined, sessionId: string, options: { autoSend?: boolean; confirm?: boolean; confirmed?: boolean } = {}): Note {
  const session = safeId(sessionId)
  const note = current(root, id, expectedVersion)
  if (note.status === 'resolved') throw invalid('Reopen this note before queueing it.')
  if (!note.grants.some((grant) => grant.principal.sessionId === session)) note.grants.push({ principal: { sessionId: session }, grantedAt: now() })
  const confirmationRequired = options.confirm === true || (note.delivery?.confirm === true && options.confirmed !== true)
  note.delivery = {
    state: 'queued',
    sessionId: session,
    queuedAt: now(),
    ...(options.autoSend ? { autoSend: true } : {}),
    ...(confirmationRequired ? { confirm: true } : {})
  }
  return save(root, note, 'queue')
}

/** Takes the note out of the queue. It stays shared; unshare withdraws that. */
export function dequeue(root: string, id: string, expectedVersion: number | undefined): Note {
  const note = current(root, id, expectedVersion)
  if (note.delivery?.state !== 'queued') throw invalid('This note is not waiting to be sent.')
  note.delivery = null
  return save(root, note, 'dequeue')
}

/** The notes waiting for one session, oldest first. `auto` keeps only those to send when it is idle. */
export function queued(root: string, sessionId: string, filter: { auto?: boolean; ids?: string[] | null } = {}): Note[] {
  const ids = filter.ids ? new Set(filter.ids) : null
  return all(root)
    .filter((note) => note.status === 'open' && note.delivery?.state === 'queued' && note.delivery.sessionId === sessionId)
    .filter((note) => !filter.auto || (note.delivery?.autoSend === true && note.delivery.confirm !== true))
    .filter((note) => !ids || ids.has(note.id))
    .sort((left, right) => (left.delivery!.queuedAt).localeCompare(right.delivery!.queuedAt) || left.id.localeCompare(right.id))
}

/** The notes went to the session as part of `runId`. */
export function markSent(root: string, ids: readonly string[], sessionId: string, runId: string): Note[] {
  const session = safeId(sessionId)
  const run = safeId(runId)
  const notes = [...new Set(ids)].map((id) => current(root, id, undefined))
  for (const note of notes) {
    if (note.status !== 'open') throw invalid('Resolved notes cannot be sent.')
    if (note.delivery?.state !== 'queued' || note.delivery.sessionId !== session) throw invalid('This note is not queued for this session.')
    if (note.delivery.confirm) throw invalid('Confirm this note before sending it.')
  }
  return notes.map((note) => {
    note.delivery = { ...note.delivery!, state: 'sent', sessionId: session, sentAt: now(), runId: run }
    delete note.delivery.autoSend
    delete note.delivery.confirm
    return save(root, note, 'deliver')
  })
}

/** The agent says it acted on a note shared with it. The note stays open until a person resolves it. */
export function markFixed(root: string, id: string, caller: { sessionId?: string | null; agentId?: string | null }, summary: string): Note {
  const note = current(root, id, undefined)
  if (!visibleTo(note, caller)) throw notFound('Note')
  const sessionId = note.delivery?.sessionId ?? caller.sessionId ?? note.grants.find((grant) => grant.principal.sessionId)?.principal.sessionId
  if (!sessionId) throw invalid('This note was never sent to a session.')
  note.delivery = { ...(note.delivery ?? { queuedAt: now() }), state: 'fixed', sessionId, fixedAt: now(), summary: bounded(summary.trim(), 2000, true, 'summary') }
  delete note.delivery.autoSend
  delete note.delivery.confirm
  return save(root, note, 'mark_fixed')
}
