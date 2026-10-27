import { BUILTIN_PLUGIN_REGISTRY } from '../../plugins/builtin'
import type { AnnotateStart } from './pages/annotatePage'
import type { CommandPageId } from './commandPages'
import type { TerminalCommandHost } from './commands'
import { parseAnnotate } from './annotateCommand'
import { sendUnsent } from './annotateSend'

type PageOptions = { runId?: string; url?: string; annotate?: AnnotateStart; usageTab?: 'analysis' | 'limit' | 'accounts'; usagePeriod?: 'today' | '7d' | '30d' | 'all' }
type OpenPage = (id: CommandPageId, options?: PageOptions) => Promise<void>
type Handler = (argument: string) => Promise<void>

/** Terminal adapters for commands declared by Harness-owned feature plugins. */
export function createBuiltinPluginCommandHandlers(host: TerminalCommandHost, openPage: OpenPage): Map<string, Handler> {
  const handlers = new Map<string, Handler>([
    ['annotations:open', async argument => {
      const start = parseAnnotate(argument)
      if (typeof start === 'string') host.ui.notify(start, 'error')
      else await openPage('annotate', { annotate: start })
    }],
    // The All annotations tab; no capture window opens until the person asks for one.
    ['annotations:notes', async () => openPage('notes')],
    ['annotations:submit', async argument => {
      host.ui.notify(await sendUnsent(host.control, host.ui, { prompt: argument.trim() }), 'info')
    }],
    ['annotations:clear', async () => {
      const { notes } = await host.control<{ notes: unknown[] }>('terminal.annotations.clear')
      host.ui.notify(notes.length ? `Resolved ${notes.length} unsent annotation${notes.length === 1 ? '' : 's'}; the agent can no longer read ${notes.length === 1 ? 'it' : 'them'}. Reopen from /annotate:notes.` : 'No unsent annotations to clear.', 'info')
    }],
    ['usage:analysis', async argument => {
      const period = argument.trim().toLowerCase()
      if (period && !['today', '7d', '30d', 'all'].includes(period)) {
        host.ui.notify('Use /usage:analysis today, 7d, 30d or all.', 'error')
        return
      }
      await openPage('usage', { usageTab: 'analysis', ...(period ? { usagePeriod: period as 'today' | '7d' | '30d' | 'all' } : {}) })
    }],
    ['usage:limit', async () => openPage('usage', { usageTab: 'limit' })],
    ['usage:accounts', async () => openPage('usage', { usageTab: 'accounts' })]
  ])
  const commands = BUILTIN_PLUGIN_REGISTRY.commands()
  for (const command of commands) {
    if (!handlers.has(`${command.pluginId}:${command.name}`)) throw new Error(`No terminal handler for built-in plugin command ${command.pluginId}:${command.name}.`)
  }
  return handlers
}

export { parseAnnotate }
