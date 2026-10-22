import type { TerminalPage } from './page'
import type { TerminalCommandHost } from './commands'
import { DoctorPage } from './pages/doctorPage'
import { AccountsPage } from './pages/accountsPage'
import { ComponentsPage } from './pages/componentsPage'
import { HubPage } from './pages/hubPage'
import { LogPage, formatRunEventLog } from './pages/logPage'
import { PermissionsPage } from './pages/permissionsPage'
import { PluginsPage } from './pages/pluginsPage'
import { SettingsPage } from './pages/settingsPage'
import { TrajectoryPage } from './pages/trajectoryPage'
import { createSettingsModel } from './settingsModel'

export type CommandPageId = 'doctor' | 'accounts' | 'permissions' | 'plugins' | 'hub' | 'components' | 'settings' | 'trajectory' | 'log'

/** Construct one independent full-screen page for a slash command. */
export function createCommandPage(host: TerminalCommandHost, id: CommandPageId, options: { runId?: string } = {}): TerminalPage {
  const theme = () => host.ui.theme
  const notify = (message: string, type?: string) => host.ui.notify(message, type === 'error' || type === 'warning' ? type : 'info')
  switch (id) {
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
      return new PluginsPage({ theme, call: host.control, ui: host.ui, changed: host.changed })
    case 'hub':
      return new HubPage({ theme, call: host.control, ui: host.ui, changed: host.changed })
    case 'components':
      return new ComponentsPage({ theme, call: host.control, ui: host.ui, notify, changed: host.changed })
    case 'settings':
      return new SettingsPage({ theme, ...createSettingsModel(host), notify, changed: host.changed })
    case 'trajectory':
      return new TrajectoryPage({
        theme, runs: host.trajectory.list, read: host.trajectory.read, copy: host.copyText,
        initialRunId: options.runId || undefined, notify, changed: host.changed
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
