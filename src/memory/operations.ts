// Operations: one applied change to the Wiki, recorded so it can be undone. Undo writes new
// revisions and never erases history. The Inbox holds what was applied, parked, or flagged.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { invalid, notFound } from '../core/errors'
import { atomicWrite, newId, now, readJson, safeId, writeJson } from '../core/fs'
import { compareText } from '../core/text'
import * as store from './store'

export interface OperationPage {
  pageId: string
  path: string
  /** Revision holding the content before this operation; `null` when the entry was created. */
  beforeRevisionId: string | null
  afterRevisionId: string
}

export interface Operation {
  id: string
  createdAt: string
  trigger: string
  pages: OperationPage[]
  undone: boolean
}

export function operationsDir(wiki: string): string {
  return join(wiki, 'operations')
}

export function listOperations(wiki: string): Operation[] {
  let names: string[]
  try {
    names = readdirSync(operationsDir(wiki))
  } catch {
    return []
  }
  const operations: Operation[] = []
  for (const name of names) {
    try {
      const operation = readJson<Operation>(join(operationsDir(wiki), name))
      if (operation && typeof operation.id === 'string' && Array.isArray(operation.pages)) operations.push({ ...operation, undone: operation.undone ?? false })
    } catch {
      // Not an operation record.
    }
  }
  return operations
}

export function lastOperationAt(wiki: string): string | null {
  return listOperations(wiki).map((operation) => operation.createdAt).sort(compareText).at(-1) ?? null
}

export interface InboxItem {
  id: string
  kind: string
  title: string
  detail: string
  pageIds: string[]
  createdAt: string
  /** Operation this item reports, so it can be undone from the Inbox. */
  operationId: string | null
  /** A parked proposal the user can accept (`kind`, `proposal`, `namespace`). */
  payload?: unknown
}

export function inbox(wiki: string, kind: string, title: string, detail: string, pageIds: string[], operationId: string | null = null, payload?: unknown): void {
  const item: InboxItem = { id: newId(), kind, title, detail, pageIds, createdAt: now(), operationId, ...(payload === undefined || payload === null ? {} : { payload }) }
  writeJson(join(wiki, 'inbox', `${item.id}.json`), item)
}

/** Inbox items, newest first. */
export function listInbox(wiki: string): InboxItem[] {
  let names: string[]
  try {
    names = readdirSync(join(wiki, 'inbox'))
  } catch {
    return []
  }
  const items: InboxItem[] = []
  for (const name of names) {
    try {
      const item = readJson<InboxItem>(join(wiki, 'inbox', name))
      if (item && typeof item.id === 'string' && typeof item.kind === 'string') items.push({ ...item, operationId: item.operationId ?? null })
    } catch {
      // Folders (`dismissed/`) and unreadable files are not items.
    }
  }
  return items.sort((left, right) => compareText(right.createdAt, left.createdAt))
}

export function dismissInboxItem(wiki: string, itemId: string): void {
  const source = join(wiki, 'inbox', `${safeId(itemId)}.json`)
  const target = join(wiki, 'inbox', 'dismissed')
  mkdirSync(target, { recursive: true })
  try {
    renameSync(source, join(target, `${itemId}.json`))
  } catch {
    throw notFound('Inbox item')
  }
}

/** Reverts an operation through new revisions. Entries it created move to `trash/`. */
export function undo(wiki: string, operationId: string): Operation {
  const path = join(operationsDir(wiki), `${safeId(operationId)}.json`)
  const operation = readJson<Operation>(path)
  if (!operation) throw notFound('Maintenance operation')
  if (operation.undone) throw invalid('This operation was already undone.')
  const short = operation.id.slice(0, 8)
  for (const page of operation.pages) {
    let current = ''
    try {
      current = readFileSync(page.path, 'utf8')
    } catch {
      current = ''
    }
    if (page.beforeRevisionId) {
      const previous = store.revisionText(wiki, page.pageId, page.beforeRevisionId)
      store.snapshot(wiki, page.pageId, current, 'user', `Before undo of ${short}`)
      atomicWrite(page.path, previous)
      store.snapshot(wiki, page.pageId, previous, 'user', `Undo of update ${short}`)
    } else {
      const trash = join(wiki, 'trash')
      mkdirSync(trash, { recursive: true })
      if (existsSync(page.path)) {
        const target = join(trash, `${page.pageId}-${now().replace(/[:.]/g, '-')}.md`)
        mkdirSync(join(target, '..'), { recursive: true })
        renameSync(page.path, target)
      }
    }
  }
  operation.undone = true
  writeJson(path, operation)
  store.log(wiki, `- ${now()} · user · undo · op \`${operation.id}\``)
  return operation
}
