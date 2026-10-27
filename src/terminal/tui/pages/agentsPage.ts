/**
 * The Agents page (`/agents`): the agent profiles a subagent can start from (PROP-0029). Built-in
 * and variant profiles are read-only and can be copied; a person's own global or project profiles
 * open in their editor and can be deleted. The harness writes every file.
 */
import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import type { AgentProfile, ProfileListing, ProfileProblem, ProfileScope } from '../../../agents/profiles'
import { formatVariant } from '../../../agents/profiles'
import type { MenuCall, MenuUi } from '../../pluginMenu'
import { headerRow, neutralRule, padded, type TabInfo } from '../chrome'
import { FilterList, type ListRow } from '../list'
import type { TerminalMouseInput } from '../mouse'
import type { TerminalPage } from '../page'

export interface AgentsOverview extends ProfileListing {
  dirs: { global: string; project: string | null }
}

export interface AgentsPageOptions {
  theme(): Theme
  call: MenuCall
  ui: MenuUi & { input(title: string, placeholder?: string): Promise<string | undefined> }
  /** Opens a file in the person's editor; absent when the host has none. */
  edit?(path: string): Promise<void>
  changed(): void
}

type Row = { kind: 'new' } | { kind: 'profile'; profile: AgentProfile } | { kind: 'problem'; problem: ProfileProblem }

export const AGENT_ACTIONS = {
  edit: 'Edit in your editor',
  copy: 'Copy to a new profile',
  remove: 'Delete'
} as const

export const AGENT_SCOPES = {
  project: 'Project: this repository only',
  global: 'Global: every folder'
} as const

const TABS = [{ id: 'agents', title: 'Agents' }] as const
const GROUP: Record<AgentProfile['source'], string> = { builtin: 'Built-in', global: 'Global', project: 'Project', variant: 'From the variant', plugin: 'From a plugin' }

function clean(value: string): string {
  return stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').replace(/[ \t]+/g, ' ').trim()
}

export class AgentsPage implements TerminalPage {
  presentation = 'fullscreen' as const
  private overview: AgentsOverview | undefined
  private error: string | undefined
  private busy = false
  private disposed = false
  private readonly list: FilterList<Row>

  constructor(private readonly options: AgentsPageOptions) {
    this.list = new FilterList<Row>({
      theme: options.theme, search: 'always', noun: ['profile', 'profiles'], empty: 'No profiles',
      onActivate: row => { if (row.data) void this.activateRow(row.data) }
    })
  }

  get focused(): boolean { return this.list.focused }
  set focused(value: boolean) { this.list.focused = value }

  activate(): void { void this.reload() }
  dispose(): void { this.disposed = true }
  tabs(): readonly TabInfo[] { return TABS }
  activeTab(): string { return 'agents' }
  hint(): string { return 'Enter choose · type to search' }

  async reload(): Promise<void> {
    try {
      this.overview = await this.options.call<AgentsOverview>('terminal.agents.list')
      this.error = undefined
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
    if (this.disposed) return
    this.list.setRows(this.rows())
    this.options.changed()
  }

  rows(): ListRow<Row>[] {
    const overview = this.overview
    if (!overview) return []
    const rows: ListRow<Row>[] = [{ id: 'new', label: 'New profile', group: 'Actions', detail: 'from a template, then opens in your editor', tone: 'accent', data: { kind: 'new' } }]
    for (const source of ['builtin', 'global', 'project', 'variant', 'plugin'] as const) {
      for (const profile of overview.profiles.filter(entry => entry.source === source)) {
        rows.push({
          id: `profile:${profile.name}`, label: profile.name, group: GROUP[source], detail: clean(profile.description), tone: 'muted',
          searchText: `${profile.name} ${profile.description} ${source}`, data: { kind: 'profile', profile }
        })
      }
    }
    for (const problem of overview.problems) {
      rows.push({
        id: `problem:${problem.source}:${problem.name}`, label: problem.name, group: 'Cannot be read', detail: clean(problem.error), tone: 'error',
        searchText: `${problem.name} ${problem.error}`, data: { kind: 'problem', problem }
      })
    }
    return rows
  }

  private async attempt(work: () => Promise<string | void>): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const message = await work()
      if (message) this.options.ui.notify(message, 'info')
    } catch (error) {
      this.options.ui.notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      this.busy = false
    }
    await this.reload()
  }

  private async open(path: string): Promise<string | void> {
    if (!this.options.edit) return `Edit the profile at ${path}.`
    await this.options.edit(path)
  }

  private async create(from: string | null): Promise<string | void> {
    const ui = this.options.ui
    const name = (await ui.input(from ? `Name for the copy of ${from}` : 'Profile name', 'lowercase-with-dashes'))?.trim()
    if (!name) return
    const scopes = this.overview?.dirs.project ? [AGENT_SCOPES.project, AGENT_SCOPES.global] : [AGENT_SCOPES.global]
    const choice = await ui.select(`Where should ${name} live?`, scopes)
    if (!choice) return
    const scope: ProfileScope = choice === AGENT_SCOPES.project ? 'project' : 'global'
    const made = await this.options.call<AgentProfile>('terminal.agents.create', { name, scope, ...(from ? { from } : {}) })
    return (await this.open(made.path!)) ?? `Saved ${made.name}.`
  }

  async activateRow(row: Row): Promise<void> {
    if (row.kind === 'new') return this.attempt(() => this.create(null))
    if (row.kind === 'problem') {
      const { problem } = row
      const scope = problem.source === 'global' || problem.source === 'project' ? problem.source : null
      const choice = await this.options.ui.select(`${problem.name} · ${problem.error}`, [AGENT_ACTIONS.edit, ...(scope ? [AGENT_ACTIONS.remove] : [])])
      if (choice === AGENT_ACTIONS.edit) return this.attempt(() => this.open(problem.path))
      if (choice === AGENT_ACTIONS.remove && scope) return this.remove(problem.name, scope)
      return
    }
    const { profile } = row
    const own = profile.source === 'global' || profile.source === 'project' ? profile.source : null
    // A package's profile comes with the package: it is switched on and off on the plugins page.
    if (profile.source === 'plugin') return
    const choice = await this.options.ui.select(`${profile.name} · ${GROUP[profile.source]}`, [...(own ? [AGENT_ACTIONS.edit] : []), AGENT_ACTIONS.copy, ...(own ? [AGENT_ACTIONS.remove] : [])])
    if (choice === AGENT_ACTIONS.edit && profile.path) return this.attempt(() => this.open(profile.path!))
    if (choice === AGENT_ACTIONS.copy) return this.attempt(() => this.create(profile.name))
    if (choice === AGENT_ACTIONS.remove && own) return this.remove(profile.name, own)
  }

  private async remove(name: string, scope: ProfileScope): Promise<void> {
    if (!await this.options.ui.confirm(`Delete ${name}?`, `This removes your ${scope} profile file. A built-in profile of the same name comes back.`)) return
    return this.attempt(async () => {
      await this.options.call('terminal.agents.remove', { name, scope })
      return `Deleted ${name}.`
    })
  }

  handleMouse(event: TerminalMouseInput) {
    return this.list.handleMouse(event)
  }

  handleInput(data: string): boolean {
    if (this.list.handleInput(data)) {
      this.options.changed()
      return true
    }
    return false
  }

  render(width: number, rows: number): string[] {
    const theme = this.options.theme()
    if (width < 1 || rows < 1) return []
    if (this.error) return [theme.fg('error', `Could not read agent profiles: ${this.error}`)]
    if (!this.overview) return [theme.fg('dim', 'Reading agent profiles…')]
    const header = headerRow('Agents', `${this.overview.profiles.length} profiles`, width, theme)
    const bodyRows = Math.max(0, rows - 7)
    const listRows = Math.max(1, Math.min(this.list.height, Math.floor(bodyRows * 0.55)))
    const output = [header, '', ...this.list.render(width, listRows), '']
    const selected = this.list.selected?.data
    const textWidth = Math.max(1, width - 4)
    output.push(neutralRule(width, theme))
    if (selected?.kind === 'profile') {
      const profile = selected.profile
      const field = (label: string, value: string) => padded(`${theme.fg('muted', `${label}: `)}${theme.fg('text', clean(value))}`, width)
      output.push(padded(theme.fg('accent', `${profile.name} · ${profile.color}`), width))
      output.push(...wrapTextWithAnsi(theme.fg('text', clean(profile.description)), textWidth))
      output.push(field('Tools', profile.tools?.join(', ') ?? 'all of the parent\'s'))
      output.push(field('Plugins', profile.plugins?.join(', ') ?? 'all of the parent\'s'))
      output.push(field('Variant', formatVariant(profile.variant) ?? 'the parent\'s'))
      output.push(field('Model', [profile.model ?? 'the parent\'s', profile.effort ? `effort ${profile.effort}` : null].filter(Boolean).join(' · ')))
      output.push(field('File', profile.path ?? 'built in'))
      output.push(padded(theme.fg('accent', 'Instructions'), width))
      output.push(...profile.instructions.split('\n').flatMap(line => wrapTextWithAnsi(theme.fg('muted', clean(line)), textWidth)))
    } else if (selected?.kind === 'problem') {
      output.push(padded(theme.fg('error', selected.problem.error), width))
      output.push(padded(theme.fg('muted', selected.problem.path), width))
    } else {
      const dirs = this.overview.dirs
      output.push(padded(theme.fg('muted', `Your profiles live in ${dirs.global}${dirs.project ? ` and ${dirs.project}` : ''}. A project profile wins over a global one, and both over a built-in one.`), width))
    }
    return output.slice(0, rows).map(line => truncateToWidth(line, width, ''))
  }
}
