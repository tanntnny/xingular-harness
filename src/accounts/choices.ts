// The model and effort each mode last used on an account. One file per account, in the account's
// own folder, so removing the account removes its choices. It never holds credentials.
import { join } from 'node:path'

import { EFFORTS, type Effort } from '../core/effort'
import { invalid } from '../core/errors'
import { now, readJsonOr, safeId, writeJson } from '../core/fs'

export interface ModeChoice {
  /** `provider/id` of the model. */
  model?: string
  effort?: Effort
  updatedAt: string
}

export interface ChoicePatch {
  model?: string
  effort?: Effort
}

const MODE = /^[a-z][a-z0-9_-]{0,31}$/
const MODEL = /^[^\s/]+\/\S+$/
const MAX_MODEL = 200

const choicesPath = (dir: string, accountId: string): string => join(dir, safeId(accountId), 'choices.json')
const validModel = (model: string): boolean => model.length <= MAX_MODEL && MODEL.test(model)
const validEffort = (effort: unknown): effort is Effort => typeof effort === 'string' && (EFFORTS as readonly string[]).includes(effort)

function validChoice(entry: Partial<ModeChoice>): ModeChoice | null {
  const model = typeof entry.model === 'string' && validModel(entry.model) ? entry.model : undefined
  const effort = validEffort(entry.effort) ? entry.effort : undefined
  if (!model && !effort) return null
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : now() }
}

/** Every saved mode of the account. A missing or unreadable file, and any invalid entry, reads as nothing. */
export function readChoices(dir: string, accountId: string): Record<string, ModeChoice> {
  const stored = readJsonOr<{ modes?: Record<string, Partial<ModeChoice>> } | null>(choicesPath(dir, accountId), null)
  const modes: Record<string, ModeChoice> = {}
  for (const [mode, entry] of Object.entries(stored?.modes ?? {})) {
    if (!MODE.test(mode) || !entry || typeof entry !== 'object') continue
    const choice = validChoice(entry)
    if (choice) modes[mode] = choice
  }
  return modes
}

/** Records one or both fields for a mode, keeping the field the patch does not name. */
export function saveChoice(dir: string, accountId: string, mode: string, patch: ChoicePatch): Record<string, ModeChoice> {
  if (!MODE.test(mode)) throw invalid('A mode is lowercase letters, digits, - or _, starting with a letter.')
  if (patch.model !== undefined && (typeof patch.model !== 'string' || !validModel(patch.model))) throw invalid('A model is provider/id.')
  if (patch.effort !== undefined && !validEffort(patch.effort)) throw invalid(`An effort is one of ${EFFORTS.join(', ')}.`)
  const modes = readChoices(dir, accountId)
  const current = modes[mode] ?? {}
  const next = validChoice({
    ...(patch.model !== undefined ? { model: patch.model } : { model: current.model }),
    ...(patch.effort !== undefined ? { effort: patch.effort } : { effort: current.effort }),
    updatedAt: now()
  })
  if (!next) throw invalid('Choose a model or an effort.')
  modes[mode] = next
  writeJson(choicesPath(dir, accountId), { modes })
  return modes
}

/**
 * The model and effort a mode starts from: its own saved field, else the fallback mode's. The
 * fallback itself has no further fallback.
 */
export function resolveChoice(modes: Record<string, ModeChoice>, mode: string, fallback = 'normal'): { model?: string; effort?: Effort } {
  const own: Partial<ModeChoice> = modes[mode] ?? {}
  const base: Partial<ModeChoice> = mode === fallback ? {} : modes[fallback] ?? {}
  return { model: own.model ?? base.model, effort: own.effort ?? base.effort }
}
