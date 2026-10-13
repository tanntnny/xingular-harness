// The `/plugins` command of a terminal session, without Pi: what it lists, what it offers for
// each row, and the conversation it has with the person. It asks through whatever interface it
// is given (Pi's own dialogs in a terminal) and changes things through one function, so the
// same flow is tested without a terminal.
import type { Attachment } from '../plugins/attachments'
import type { Contribution, Plugin } from '../plugins/types'

export interface MenuUi {
  select(title: string, options: string[]): Promise<string | undefined>
  confirm(title: string, message: string): Promise<boolean>
  notify(message: string, level?: 'info' | 'warning' | 'error'): void
}

/** `plugins.list`, `plugins.attach`, `plugins.detach`, `plugins.trust`, `plugins.untrust`. */
export type MenuCall = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>

export interface MenuRow {
  /** The plugin's id, or one contribution's. */
  id: string
  label: string
  on: boolean
  /** The plugin it is, or belongs to. */
  plugin: Plugin
  /** Set when the row is the whole plugin. */
  whole: boolean
}

const here = (attachment: Attachment, projectId: string | null): boolean => {
  if (projectId && attachment.on.projectIds.includes(projectId)) return true
  if (projectId && attachment.off.projectIds.includes(projectId)) return false
  return attachment.global
}

const mark = (on: boolean): string => (on ? '●' : '○')

/** What can be switched or trusted from here: each found or installed plugin, and each item of the rest that has a switch. */
export function menuRows(plugins: readonly Plugin[], projectId: string | null): MenuRow[] {
  const rows: MenuRow[] = []
  for (const plugin of plugins) {
    if (plugin.attachment) {
      const on = here(plugin.attachment, projectId)
      rows.push({ id: plugin.id, plugin, whole: true, on, label: `${mark(on)} ${plugin.title}${plugin.trust === 'untrusted' ? ' · code not trusted' : plugin.runsCode ? ' · runs code' : ''}` })
      continue
    }
    if (plugin.trust !== 'none') rows.push({ id: plugin.id, plugin, whole: true, on: plugin.trust === 'trusted', label: `${mark(plugin.trust === 'trusted')} ${plugin.title} · ${plugin.trust === 'trusted' ? 'code trusted' : 'code not trusted'}` })
    for (const entry of plugin.contributions) {
      if (!entry.attachment) continue
      rows.push({ id: entry.id, plugin, whole: false, on: entry.state === 'on', label: `${mark(entry.state === 'on')} ${entry.name} · ${kindWord(entry)} in ${plugin.title}` })
    }
  }
  return rows
}

const kindWord = (entry: Contribution): string => (entry.kind === 'connection' ? 'connected app' : entry.kind === 'code' ? 'extension' : entry.kind)

const SWITCH_OFF_PROJECT = 'Switch off for this project'
const SWITCH_ON_PROJECT = 'Switch on for this project'
const SWITCH_OFF_EVERYWHERE = 'Switch off everywhere'
const SWITCH_ON_EVERYWHERE = 'Switch on everywhere'
const TRUST = 'Trust its code'
const UNTRUST = 'Stop trusting its code'
const BACK = 'Back'
const DONE = 'Done'

/** What a person can do with one row. A whole plugin whose code waits for trust can be trusted here. */
export function rowActions(row: MenuRow, projectId: string | null): string[] {
  const switchable = row.whole ? row.plugin.attachment !== null : true
  const actions: string[] = []
  if (switchable) {
    if (projectId) actions.push(row.on ? SWITCH_OFF_PROJECT : SWITCH_ON_PROJECT)
    actions.push(row.on ? SWITCH_OFF_EVERYWHERE : SWITCH_ON_EVERYWHERE)
  }
  if (row.whole && row.plugin.code) actions.push(row.plugin.trust === 'untrusted' ? TRUST : UNTRUST)
  return [...actions, BACK]
}

/**
 * Runs the command: list, pick a row, pick what to do, until the person is done. Nothing changes
 * without a choice made here, and trusting code asks once more with the files in view.
 */
export async function runPluginsMenu(ui: MenuUi, call: MenuCall, projectId: string | null): Promise<void> {
  let changed = false
  for (;;) {
    const rows = menuRows(await call<Plugin[]>('plugins.list'), projectId)
    if (!rows.length) {
      ui.notify('There is nothing to switch or trust here yet.', 'info')
      return
    }
    const picked = await ui.select(`Plugins${changed ? ' (changes apply when this session restarts)' : ''}`, [...rows.map((row) => row.label), DONE])
    const row = rows.find((candidate) => candidate.label === picked)
    if (!row) break
    const action = await ui.select(`${row.plugin.title}: ${row.plugin.description || 'No description.'}`, rowActions(row, projectId))
    if (!action || action === BACK) continue
    try {
      if (action === TRUST || action === UNTRUST) {
        const code = row.plugin.code!
        if (action === TRUST) {
          const sure = await ui.confirm('Trust this code?', `${code.files.join('\n')}\n\nFingerprint ${code.hash.slice(0, 12)}. It runs inside the session and can do anything this app can, including reading your files and credentials.`)
          if (!sure) continue
        }
        await call(action === TRUST ? 'plugins.trust' : 'plugins.untrust', { hash: code.hash })
      } else {
        const on = action === SWITCH_ON_PROJECT || action === SWITCH_ON_EVERYWHERE
        await call(on ? 'plugins.attach' : 'plugins.detach', { id: row.id, everywhere: action === SWITCH_ON_EVERYWHERE || action === SWITCH_OFF_EVERYWHERE })
      }
      changed = true
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }
  if (changed) ui.notify('Saved. It applies when this session restarts.', 'info')
}
