import type { TerminalPage } from './page'
import type { TerminalCommandHost } from './commands'
import { DoctorPage } from './pages/doctorPage'
import { AccountsPage } from './pages/accountsPage'
import { BrowserPage } from './pages/browserPage'
import { PluginsPage } from './pages/pluginsPage'
import { HubPage } from './pages/hubPage'
import { LogPage, formatRunEventLog } from './pages/logPage'
import { PermissionsPage } from './pages/permissionsPage'
import { SettingsPage } from './pages/settingsPage'
import { TrajectoryPage } from './pages/trajectoryPage'
import { WorktreesPage } from './pages/worktreesPage'
import { AnnotatePage, type AnnotateStart } from './pages/annotatePage'
import { SubagentsPage } from './pages/subagentsPage'
import { AgentsPage } from './pages/agentsPage'
import { UsagePage } from './pages/usagePage'
import { ContextPage, type ContextTab } from './pages/contextPage'
import { RemoteControlPage } from './pages/remoteControlPage'
import { createSettingsModel } from './settingsModel'

export type CommandPageId = 'doctor' | 'accounts' | 'permissions' | 'plugins' | 'hub' | 'components' | 'settings' | 'trajectory' | 'log' | 'harness' | 'skills' | 'connections' | 'tools' | 'worktree' | 'notes' | 'annotate' | 'subagents' | 'agents' | 'usage' | 'context' | 'remote-control'

/** Construct one independent full-screen page for a slash command. */
export function createCommandPage(host: TerminalCommandHost, id: CommandPageId, options: { runId?: string; url?: string; annotate?: AnnotateStart; usageTab?: 'analysis' | 'limit' | 'accounts'; usagePeriod?: 'today' | '7d' | '30d' | 'all'; contextTab?: ContextTab; close?(): void; navigate?(id: CommandPageId, runId?: string): void } = {}): TerminalPage {
  const theme = () => host.ui.theme
  const notify = (message: string, type?: string) => host.ui.notify(message, type === 'error' || type === 'warning' ? type : 'info')
  switch (id) {
    case 'remote-control':
      return new RemoteControlPage({ theme, call: host.control, changed: host.changed, copy: host.copyText, notify })
    case 'context':
      return new ContextPage({
        theme, call: host.control, changed: host.changed,
        initialTab: options.contextTab ?? 'details', initialRunId: options.runId,
        runs: host.trajectory.list, readDetails: runId => host.control('terminal.trajectory.details', { runId }) as Promise<import('./pages/contextPage').RunDetails>,
        openTrajectory: runId => options.navigate?.('trajectory', runId),
        openVariant: () => options.navigate?.('harness'),
        compact: async () => { await host.session().compact?.() },
        confirm: (title, message) => host.ui.confirm(title, message)
      })
    case 'usage':
      return new UsagePage({ theme, call: host.control, changed: host.changed, initialTab: options.usageTab === 'limit' ? 'limits' : options.usageTab === 'accounts' ? 'accounts' : 'analysis', ...(options.usagePeriod ? { initialPeriod: options.usagePeriod } : {}) })
    case 'doctor':
      return new DoctorPage({ theme, call: host.control, confirm: host.ui.confirm.bind(host.ui), select: host.ui.select.bind(host.ui), changed: host.changed,
        selection: () => {
          const model = host.runtime().snapshot().model
          return { model: model ? `${model.provider}/${model.id}` : null, tools: host.session().getActiveToolNames() }
        }
      })
    case 'accounts':
      return new AccountsPage({
        theme, call: host.control, ui: host.ui,
        session: () => host.runtime().snapshot().account,
        relaunch: host.shutdown, changed: host.changed
      })
    case 'permissions':
      return new PermissionsPage({
        theme, permissions: () => host.runtime().permissions(),
        setFullPermission: enabled => host.runtime().setFullPermission(enabled),
        setGlobalTool: (tool, allowed) => host.runtime().setGlobalTool(tool, allowed),
        activeTools: () => host.session().getActiveToolNames(),
        confirm: (title, message) => host.ui.confirm(title, message), notify, changed: host.changed
      })
    case 'plugins':
      return new PluginsPage({
        theme, call: host.control, changed: host.changed,
        ui: { select: host.ui.select.bind(host.ui), confirm: host.ui.confirm.bind(host.ui), notify, input: host.ui.input.bind(host.ui) }
      })
    case 'hub':
      return new HubPage({
        theme, call: host.control, changed: host.changed,
        ui: { select: host.ui.select.bind(host.ui), confirm: host.ui.confirm.bind(host.ui), notify }
      })
    case 'harness':
    case 'skills':
    case 'connections':
    case 'tools':
    case 'components':
      return new BrowserPage({
        theme, call: host.control, changed: host.changed,
        section: id === 'harness' ? 'overview' : id === 'components' ? 'library' : id,
        source: 'installed',
        ui: {
          select: host.ui.select.bind(host.ui), confirm: host.ui.confirm.bind(host.ui), notify: host.ui.notify.bind(host.ui), input: host.ui.input.bind(host.ui),
          secretInput: (title, placeholder) => {
            const ui = host.ui as typeof host.ui & { secretInput?: typeof host.ui.input }
            if (!ui.secretInput) throw new Error('Masked credential entry is unavailable in this host.')
            return ui.secretInput(title, placeholder)
          }
        },
        runtime: () => ({ skills: host.session().resourceLoader.getSkills().skills,
          tools: host.session().getAllTools(), activeTools: host.session().getActiveToolNames(), skillCommands: host.session().settingsManager.getEnableSkillCommands() }),
        permissions: () => host.runtime().permissions(), setGlobalTool: (tool, allowed) => host.runtime().setGlobalTool(tool, allowed),
        useSkill: name => {
          const draft = host.ui.getEditorText()
          host.setEditorText(`$${name}${draft ? ' ' + draft : ' '}`)
          options.close?.()
        }
      })
    case 'worktree':
      return new WorktreesPage({
        theme, call: host.control, changed: host.changed, relaunch: host.shutdown,
        ui: { select: host.ui.select.bind(host.ui), confirm: host.ui.confirm.bind(host.ui), notify: host.ui.notify.bind(host.ui), input: host.ui.input.bind(host.ui) }
      })
    case 'notes':
    case 'annotate':
      return new AnnotatePage({
        theme, call: host.control, changed: host.changed, start: options.annotate ?? { kind: 'web' }, initialTab: id === 'notes' ? 'all' : 'annotate',
        ui: { select: host.ui.select.bind(host.ui), confirm: host.ui.confirm.bind(host.ui), notify: host.ui.notify.bind(host.ui), input: host.ui.input.bind(host.ui) }
      })
    case 'settings':
      return new SettingsPage({ theme, ...createSettingsModel(host), notify, changed: host.changed })
    case 'trajectory':
      return new TrajectoryPage({
        theme, runs: host.trajectory.list, read: host.trajectory.read, copy: host.copyText,
        initialRunId: options.runId || undefined, openContext: runId => options.navigate?.('context', runId), notify, changed: host.changed
      })
    case 'subagents':
      return new SubagentsPage({ theme, snapshot: host.subagents, changed: host.changed })
    case 'agents':
      return new AgentsPage({
        theme, call: host.control, changed: host.changed, ...(host.editFile ? { edit: host.editFile.bind(host) } : {}),
        ui: { select: host.ui.select.bind(host.ui), confirm: host.ui.confirm.bind(host.ui), notify: host.ui.notify.bind(host.ui), input: host.ui.input.bind(host.ui) }
      })
    case 'log':
      return new LogPage({
        theme, changed: host.changed,
        load: async () => {
          const [diagnostics, runs] = await Promise.all([host.logs.read(), host.trajectory.list()])
          const snapshots = await Promise.all(runs.map(run => host.trajectory.read(run.id)))
          return [
            { title: 'Diagnostics', text: diagnostics || 'No Harness diagnostics have been captured by this host.' },
            { title: 'Run Events', text: formatRunEventLog(snapshots) }
          ]
        }
      })
  }
}
