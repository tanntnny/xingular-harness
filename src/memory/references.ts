// Selected references: Wiki pages and skills a person attached to one request. Each is pinned to
// a revision when it is selected, so what the model reads cannot change under it, and the rest
// of a long reference can be retrieved only at that revision.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { invalid, notFound } from '../core/errors'
import * as frontmatter from '../core/frontmatter'
import { readJson, safeId } from '../core/fs'
import { charCount } from '../core/text'
import type { Source } from './runContext'
import * as store from './store'
import { entryFile, entryId, resolveEntry } from './wiki'

export interface PinnedReference {
  kind: 'page' | 'skill'
  id: string
  label: string
  revision: string
}

/**
 * Pins the entry's current content. The latest revision is reused when it already holds that
 * content; otherwise a new one is written. The entry must be a page or a saved skill.
 */
export function pin(root: string, kind: 'page' | 'skill', id: string): string {
  return pinAll(root, [{ kind, id }])[0]
}

/** Pins several entries, resolving every one before any snapshot is written. */
export function pinAll(root: string, items: readonly { kind: 'page' | 'skill'; id: string }[]): string[] {
  const wiki = store.wikiDir(root)
  const contents = items.map(({ kind, id }) => {
    const entry = resolveEntry(root, id)
    const valid = kind === 'page' ? entry.kind === 'page' : entry.kind === 'registry' && entry.item.kind === 'skills'
    if (!valid || entryId(entry) !== id) throw invalid('The selected reference is not a Wiki page or saved skill.')
    return readFileSync(entryFile(entry), 'utf8')
  })
  return items.map(({ id }, index) => {
    const current = store.currentRevision(wiki, id)
    if (current) {
      try {
        if (store.revisionText(wiki, id, current) === contents[index]) return current
      } catch {
        // The manifest names a revision whose text is gone; pin a new one.
      }
    }
    return store.snapshot(wiki, id, contents[index], 'user', 'Pinned chat reference').id
  })
}

/** The pinned revision's body without its frontmatter. */
export function body(root: string, id: string, revision: string | null): string {
  if (!revision) throw invalid('This reference has no pinned revision.')
  const text = store.revisionText(store.wikiDir(root), id, revision)
  return frontmatter.bodyOf(text)
}

const PAGE_CHARS = 12_000

/** A window of a reference that was selected for the caller's current run. */
export function readPinned(root: string, runId: string | null | undefined, id: string, revision: string, offset: number): string {
  if (!runId) throw invalid('Pinned references require a current run.')
  const pack = readJson<{ sections?: { id: string; sources?: Source[] }[] }>(join(root, 'runs', safeId(runId), 'context.json'))
  if (!pack) throw notFound('Run context')
  const selected = (pack.sections ?? [])
    .filter((section) => section.id === 'references')
    .flatMap((section) => section.sources ?? [])
    .find((source) => source.id === id && source.revision === revision && (source.kind === 'page' || source.kind === 'skill'))
  if (!selected) throw invalid('This revision was not selected for the current reply.')
  const characters = Array.from(body(root, id, revision))
  const count = characters.length
  if (offset > count) throw invalid('The reference offset is past the end.')
  const excerpt = characters.slice(offset, offset + PAGE_CHARS).join('')
  const end = offset + charCount(excerpt)
  return `[${id}@${revision}] · characters ${offset}–${end} of ${count} · nextOffset: ${end < count ? end : 'none'}\n\n${excerpt}`
}
