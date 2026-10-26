import { BUILTIN_PLUGIN_REGISTRY } from '../../plugins/builtin'
import type { AnnotateStart } from './pages/annotatePage'
import type { CommandPageId } from './commandPages'
import type { TerminalCommandHost } from './commands'
import { parseAnnotate } from './annotateCommand'

type PageOptions = { runId?: string; url?: string; annotate?: AnnotateStart; usageTab?: 'analysis' | 'limit'; usagePeriod?: 'today' | '7d' | '30d' | 'all' }
type OpenPage = (id: CommandPageId, options?: PageOptions) => Promise<void>
type Handler = (argument: string) => Promise<void>

/** Terminal adapters for commands declared by Harness-owned feature plugins. */
export function createBuiltinPluginCommandHandlers(host: TerminalCommandHost, openPage: OpenPage): Map<string, Handler> {
  const handlers = new Map<string, Handler>([
    ['annotations:notes', async () => openPage('notes')],
    ['annotations:annotate', async argument => {
      const start = parseAnnotate(argument)
      if (typeof start === 'string') host.ui.notify(start, 'error')
      else await openPage('annotate', { annotate: start })
    }],
    ['usage:analysis', async argument => {
      const period = argument.trim().toLowerCase()
      if (period && !['today', '7d', '30d', 'all'].includes(period)) {
        host.ui.notify('Use /usage:analysis today, 7d, 30d or all.', 'error')
        return
      }
      await openPage('usage', { usageTab: 'analysis', ...(period ? { usagePeriod: period as 'today' | '7d' | '30d' | 'all' } : {}) })
    }],
    ['usage:limit', async () => openPage('usage', { usageTab: 'limit' })]
  ])
  const commands = BUILTIN_PLUGIN_REGISTRY.commands()
  for (const command of commands) {
    if (!handlers.has(`${command.pluginId}:${command.name}`)) throw new Error(`No terminal handler for built-in plugin command ${command.pluginId}:${command.name}.`)
  }
  return handlers
}

export { parseAnnotate }
