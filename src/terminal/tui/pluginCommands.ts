import { BUILTIN_PLUGIN_REGISTRY } from '../../plugins/builtin'
import type { AnnotateStart } from './pages/annotatePage'
import type { CommandPageId } from './commandPages'
import type { TerminalCommandHost } from './commands'
import { parseAnnotate } from './annotateCommand'

type PageOptions = { runId?: string; url?: string; annotate?: AnnotateStart }
type OpenPage = (id: CommandPageId, options?: PageOptions) => Promise<void>
type Handler = (argument: string) => Promise<void>

/** Terminal adapters for commands declared by Harness-owned feature plugins. */
export function createBuiltinPluginCommandHandlers(host: TerminalCommandHost, openPage: OpenPage): Map<string, Handler> {
  const handlers = new Map<string, Handler>([
    ['doctor', async () => openPage('doctor')],
    ['worktree', async () => openPage('worktree')],
    ['trajectory', async argument => openPage('trajectory', { runId: argument })],
    ['subagents', async () => openPage('subagents')],
    ['notes', async () => openPage('notes')],
    ['annotate', async argument => {
      const start = parseAnnotate(argument)
      if (typeof start === 'string') host.ui.notify(start, 'error')
      else await openPage('annotate', { annotate: start })
    }]
  ])
  const commands = BUILTIN_PLUGIN_REGISTRY.commands()
  for (const command of commands) {
    if (!handlers.has(command.name)) throw new Error(`No terminal handler for built-in plugin command ${command.pluginId}:${command.name}.`)
  }
  return handlers
}

export { parseAnnotate }
