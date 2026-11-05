// The model and effort last selected on an account. One file per account, in the account's own
// folder, so removing the account removes its selection. It never holds credentials.
//
// Earlier releases stored a selection per composer mode. That file is still read: the newest
// legacy entry becomes the account's one selection, and the next save writes the flat shape.
import { join } from 'node:path'

import { EFFORTS, type Effort } from '../core/effort'
import { invalid } from '../core/errors'
import { now, readJsonOr, safeId, writeJson } from '../core/fs'

export interface AccountSelection {
  /** `provider/id` of the model. */
  model?: string
  effort?: Effort
  updatedAt: string
}

export interface SelectionPatch {
  model?: string
  effort?: Effort
}

interface SelectionFields {
  model?: unknown
  effort?: unknown
  updatedAt?: unknown
}

interface StoredSelection extends SelectionFields {
  /** The pre-one-selection shape: `{ modes: { normal: {...}, plan: {...} } }`. */
  modes?: unknown
}

const MODEL = /^[^\s/]+\/\S+$/
const MAX_MODEL = 200
const choicesPath = (dir: string, accountId: string): string => join(dir, safeId(accountId), 'choices.json')
const validModel = (model: string): boolean => model.length <= MAX_MODEL && MODEL.test(model)
const validEffort = (effort: unknown): effort is Effort => typeof effort === 'string' && (EFFORTS as readonly string[]).includes(effort)

/** A valid selection from one stored entry, or null when it names neither a model nor an effort. */
function validSelection(entry: SelectionFields): AccountSelection | null {
  const model = typeof entry.model === 'string' && validModel(entry.model) ? entry.model : undefined
  const effort = validEffort(entry.effort) ? entry.effort : undefined
  if (!model && !effort) return null
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : ''
  }
}

/** `normal` wins a legacy tie, then `plan`; other modes follow in name order. */
function modeRank(mode: string): number {
  return mode === 'normal' ? 0 : mode === 'plan' ? 1 : 2
}

/**
 * The account's selection. A missing, unreadable or invalid file reads as nothing. A legacy
 * per-mode file contributes its newest valid entry; ties prefer normal, then plan.
 */
export function readSelection(dir: string, accountId: string): AccountSelection | null {
  const stored = readJsonOr<StoredSelection | null>(choicesPath(dir, accountId), null)
  if (!stored || typeof stored !== 'object') return null
  const direct = validSelection(stored)
  if (direct) return direct
  const modes = stored.modes
  if (!modes || typeof modes !== 'object' || Array.isArray(modes)) return null
  const entries: Array<AccountSelection & { mode: string }> = []
  for (const [mode, value] of Object.entries(modes as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const choice = validSelection(value as SelectionFields)
    if (choice) entries.push({ ...choice, mode })
  }
  entries.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
    || modeRank(left.mode) - modeRank(right.mode)
    || left.mode.localeCompare(right.mode))
  const newest = entries[0]
  if (!newest) return null
  const { mode: _mode, ...selection } = newest
  return selection
}

/** Records one or both fields, keeping the field the patch does not name. */
export function saveSelection(dir: string, accountId: string, patch: SelectionPatch): AccountSelection {
  if (patch.model !== undefined && (typeof patch.model !== 'string' || !validModel(patch.model))) throw invalid('A model is provider/id.')
  if (patch.effort !== undefined && !validEffort(patch.effort)) throw invalid(`An effort is one of ${EFFORTS.join(', ')}.`)
  const current = readSelection(dir, accountId)
  const next = validSelection({
    ...(patch.model !== undefined ? { model: patch.model } : current?.model ? { model: current.model } : {}),
    ...(patch.effort !== undefined ? { effort: patch.effort } : current?.effort ? { effort: current.effort } : {}),
    updatedAt: now()
  })
  if (!next) throw invalid('Choose a model or an effort.')
  writeJson(choicesPath(dir, accountId), next)
  return next
}
