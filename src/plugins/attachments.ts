// What is switched on, and for whom. One file in the data root holds every choice a person made
// about a plugin or one of its contributions; one rule reads it: the narrowest scope that says
// something wins, an agent before a project before everywhere. With no entry, the thing keeps
// its own default (what loads today stays on; a person's registry item is off until switched on).
import { join } from 'node:path'

import { readJsonOr, writeJson } from '../core/fs'

/** Who a choice applies to. Neither id means everywhere. */
export interface AttachScope {
  agentId?: string | null
  projectId?: string | null
}

interface Entries {
  on: string[]
  off: string[]
}

export interface Attachments {
  version: 1
  global: Entries
  agents: Record<string, Entries>
  projects: Record<string, Entries>
  /** Values a plugin reads, such as a limit. Keyed by plugin id. */
  settings: Record<string, Record<string, unknown>>
}

/** Where one id is switched on and off, as data for a screen. */
export interface Attachment {
  /** On everywhere, unless a narrower scope says otherwise. */
  global: boolean
  on: { agentIds: string[]; projectIds: string[] }
  off: { agentIds: string[]; projectIds: string[] }
}

const path = (root: string): string => join(root, 'config/plugin-attachments.json')
const legacyPath = (root: string): string => join(root, 'config/registry-enabled.json')

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])
const entries = (value: unknown): Entries => {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return { on: strings(record.on), off: strings(record.off) }
}
const scoped = (value: unknown): Record<string, Entries> => Object.fromEntries(Object.entries((value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>).map(([id, item]) => [id, entries(item)]))

/**
 * The registry's earlier file: enabled ids keyed by project id, `global` (once `personal`) for
 * everyone, and `builtinOff` for built-in items a person switched off. It is read until the
 * first change is saved here, and never written again.
 */
function fromLegacy(root: string): Attachments {
  const legacy = readJsonOr<unknown>(legacyPath(root), {})
  const map = (legacy && typeof legacy === 'object' && !Array.isArray(legacy) ? legacy : {}) as Record<string, unknown>
  const projects: Record<string, Entries> = {}
  for (const [key, ids] of Object.entries(map)) {
    if (key === 'global' || key === 'personal' || key === 'builtinOff') continue
    projects[key] = { on: strings(ids), off: [] }
  }
  return { version: 1, global: { on: [...new Set([...strings(map.global), ...strings(map.personal)])], off: strings(map.builtinOff) }, agents: {}, projects, settings: {} }
}

export function load(root: string): Attachments {
  const stored = readJsonOr<Record<string, unknown> | null>(path(root), null)
  if (!stored || typeof stored !== 'object' || stored.version !== 1) return fromLegacy(root)
  const settings = (stored.settings && typeof stored.settings === 'object' && !Array.isArray(stored.settings) ? stored.settings : {}) as Attachments['settings']
  return { version: 1, global: entries(stored.global), agents: scoped(stored.agents), projects: scoped(stored.projects), settings }
}

export function save(root: string, attachments: Attachments): void {
  const kept = (map: Record<string, Entries>): Record<string, Entries> => Object.fromEntries(Object.entries(map).filter(([, item]) => item.on.length || item.off.length))
  writeJson(path(root), { ...attachments, agents: kept(attachments.agents), projects: kept(attachments.projects) })
}

const said = (item: Entries | undefined, ids: readonly string[]): boolean | null => {
  if (!item) return null
  // The first id is the thing itself; the rest are what it belongs to.
  for (const id of ids) {
    if (item.off.includes(id)) return false
    if (item.on.includes(id)) return true
  }
  return null
}

/** What the stored choices say for a caller, or `null` when none applies. `ids` is the thing, then what it belongs to. */
export function decided(attachments: Attachments, ids: readonly string[], caller: AttachScope = {}): boolean | null {
  return (caller.agentId ? said(attachments.agents[caller.agentId], ids) : null) ?? (caller.projectId ? said(attachments.projects[caller.projectId], ids) : null) ?? said(attachments.global, ids)
}

export function attached(attachments: Attachments, ids: readonly string[], caller: AttachScope, fallback: boolean): boolean {
  return decided(attachments, ids, caller) ?? fallback
}

function entriesAt(attachments: Attachments, scope: AttachScope): Entries {
  if (scope.agentId) return (attachments.agents[scope.agentId] ??= { on: [], off: [] })
  if (scope.projectId) return (attachments.projects[scope.projectId] ??= { on: [], off: [] })
  return attachments.global
}

/**
 * Switches one thing on or off for a scope. A choice that only repeats what the wider scopes
 * already say is not kept, so the thing follows them again when they change.
 */
export function set(attachments: Attachments, ids: readonly string[], scope: AttachScope, on: boolean, fallback: boolean): void {
  const [id] = ids
  const target = entriesAt(attachments, scope.agentId ? { agentId: scope.agentId } : scope)
  target.on = target.on.filter((item) => item !== id)
  target.off = target.off.filter((item) => item !== id)
  // An agent works in different projects, so a project's choice about this thing cannot stand in for the agent's.
  const projectSays = !!scope.agentId && Object.values(attachments.projects).some((item) => said(item, ids) !== null)
  const inherited = decided(attachments, ids, scope.agentId ? { agentId: scope.agentId } : scope) ?? fallback
  if (on !== inherited || projectSays) (on ? target.on : target.off).push(id)
}

export function describe(attachments: Attachments, id: string, fallback: boolean): Attachment {
  const where = (map: Record<string, Entries>, list: 'on' | 'off'): string[] => Object.entries(map).filter(([, item]) => item[list].includes(id)).map(([key]) => key)
  return {
    global: said(attachments.global, [id]) ?? fallback,
    on: { agentIds: where(attachments.agents, 'on'), projectIds: where(attachments.projects, 'on') },
    off: { agentIds: where(attachments.agents, 'off'), projectIds: where(attachments.projects, 'off') }
  }
}

/** Forgets an agent's or a project's own choices, when it is deleted. */
export function forget(attachments: Attachments, scope: AttachScope): void {
  if (scope.agentId) delete attachments.agents[scope.agentId]
  if (scope.projectId) delete attachments.projects[scope.projectId]
}

/** Removes one capability's choices without disturbing the other items in each scope. */
export function forgetId(attachments: Attachments, id: string): void {
  const forgetFrom = (item: Entries): void => {
    item.on = item.on.filter((entry) => entry !== id)
    item.off = item.off.filter((entry) => entry !== id)
  }
  forgetFrom(attachments.global)
  for (const item of Object.values(attachments.agents)) forgetFrom(item)
  for (const item of Object.values(attachments.projects)) forgetFrom(item)
  attachments.agents = Object.fromEntries(Object.entries(attachments.agents).filter(([, item]) => item.on.length || item.off.length))
  attachments.projects = Object.fromEntries(Object.entries(attachments.projects).filter(([, item]) => item.on.length || item.off.length))
}
