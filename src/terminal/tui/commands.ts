import { isAbsolute, relative, resolve } from 'node:path'
import { SessionManager, type AgentSession, type ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { CORE_COMMANDS, coreCommand } from '../../commands/registry'
import { commandRoutes, promptCommandAvailable } from '../../commands/routes'
import { BUILTIN_PLUGIN_REGISTRY } from '../../plugins/builtin'
import { pluginCommandPrefix } from '../../plugins/commandPrefix'
import { PageOverlay } from './pageOverlay'
import { ModelPicker } from './modelPicker'
import { TreePicker } from './treePicker'
import type { AnnotateStart } from './pages/annotatePage'
import { createCommandPage, type CommandPageId } from './commandPages'
import { pageOverlayOptions } from './dialogGeometry'
import { ResumeSessionsPage } from './sessionPicker'
import type { SkillEntry } from './skillInvocation'
import type { TerminalRuntime } from './runtime'
import type { TerminalTrajectoryRun, TerminalTrajectorySnapshot } from '../trajectory'
import type { TodoEntry } from '../opentui/model'
import type { TerminalSubagentActivity } from '../subagentMonitor'
import { groupTerminalCommands, type TerminalCommandCompletion, type TerminalCommandHelpGroup } from '../commandHelp'
import { createBuiltinPluginCommandHandlers } from './pluginCommands'
export type { TerminalCommandCompletion } from '../commandHelp'
export { parseAnnotate } from './pluginCommands'

export interface TerminalCommandHost {
  session(): AgentSession
  /** Navigation is scope checked by the Harness runtime adapter. */
  runtime(): Pick<TerminalRuntime, 'newSession' | 'switchSession' | 'fork' | 'importFromJsonl' | 'reload' | 'navigateTree' | 'installationDeviceId' | 'permissions' | 'setFullPermission' | 'setGlobalTool' | 'snapshot' | 'interrupt'>
  /** The protected `accounts.*`, `plugins.*` and `hub.*` calls of this session, made with its control key. */
  /** Protected Harness calls made with this session's control key. */
  control: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
  ui: ExtensionUIContext
  cwd(): string
  branch(): string | null
  sessionDirectory(): string
  refresh(): void
  changed(): void
  showHelp(groups: TerminalCommandHelpGroup[]): void
  /** The latest todo list of this reply, or an empty list. */
  todo(): Promise<readonly TodoEntry[]>
  showTodo(items: readonly TodoEntry[]): void
  plan(brief: string): void
  /** Asks a side question in its own tool-free session; empty text dismisses the one showing. */
  btw(question: string): Promise<void>
  shutdown(): void
  setEditorText(text: string): void
  copyText(text: string): Promise<void>
  suspend?(): Promise<void>
  /** Opens a file in the person's editor and resolves once the editor closes. */
  editFile?(path: string): Promise<void>
  hotkeys?(): string
  logs: { read(): Promise<string> }
  subagents(): readonly TerminalSubagentActivity[]
  trajectory: {
    list(): Promise<TerminalTrajectoryRun[]>
    read(runId: string, afterSequence?: number): Promise<TerminalTrajectorySnapshot>
  }
}

const BUILTINS: TerminalCommandCompletion[] = CORE_COMMANDS.map((command) => ({
  name: command.name,
  ...('aliases' in command ? { aliases: [...command.aliases] } : {}),
  description: command.description,
  group: command.group
}))

const COMMAND_ALIASES = new Map(BUILTINS.flatMap(command => (command.aliases ?? []).map(alias => [alias, command.name] as const)))
const CORE_PROMPT_NAMES = new Set([...BUILTINS.map(command => command.name), ...COMMAND_ALIASES.keys()])

const LEGACY_BUILTIN_COMMAND_ALIASES = new Map<string, string>([
  ['doctor:doctor', 'doctor'], ['plugin:doctor', 'doctor'],
  ['worktrees:worktree', 'worktree'], ['plugin:worktree', 'worktree'],
  ['history:trajectory', 'trajectory'], ['plugin:trajectory', 'trajectory'],
  ['subagents:subagents', 'subagents'], ['plugin:subagents', 'subagents'],
  ['subagents:agents', 'agents'], ['plugin:agents', 'agents']
])

export function createTerminalCommands(host: TerminalCommandHost) {
  const notify = (text: string) => host.ui.notify(text, 'info')
  const choose = async <T>(title: string, items: T[], label: (item: T, index: number) => string) => {
    const labels = items.map(label)
    const selected = await host.ui.select(title, labels)
    return selected === undefined ? undefined : items[labels.indexOf(selected)]
  }
  /** The skills this session may be asked to use, each invoked as `$name`. Off with the "Skill commands" setting. */
  const skills = (): SkillEntry[] => {
    const session = host.session()
    if (!session.settingsManager.getEnableSkillCommands()) return []
    return session.resourceLoader.getSkills().skills.map((skill) => ({ name: skill.name, description: skill.description }))
  }

  async function openPage(id: CommandPageId, options: { runId?: string; url?: string; annotate?: AnnotateStart; usageTab?: 'analysis' | 'limit' | 'accounts'; usagePeriod?: 'today' | '7d' | '30d' | 'all' } = {}) {
    let close = () => {}
    const page = createCommandPage(host, id, { ...options, close: () => close() })
    await host.ui.custom<void>((tui, _theme, _keys, done) => {
      close = () => done(undefined)
      return new PageOverlay({ page, tui, theme: () => host.ui.theme, close, changed: host.changed })
    }, { overlay: true, overlayOptions: pageOverlayOptions(page.presentation) })
  }

  const pluginHandlers = createBuiltinPluginCommandHandlers(host, openPage)
  const pluginCommands = BUILTIN_PLUGIN_REGISTRY.commands()
  const builtinPrefixes = new Map(pluginCommands.map(command => [command.prefix, command.pluginId]))
  const prefixCache = new WeakMap<object, string>()
  type ExtensionCommand = ReturnType<AgentSession['extensionRunner']['getRegisteredCommands']>[number]
  const extensionCommands = () => {
    return commandRoutes(host.session().extensionRunner.getRegisteredCommands().map(command => {
      const source = command.sourceInfo
      let prefix = prefixCache.get(source)
      if (!prefix) {
        prefix = pluginCommandPrefix(source)
        prefixCache.set(source, prefix)
      }
      const owner = source.origin === 'package'
        ? `package:${source.baseDir ?? source.source}`
        : `extension:${source.path}`
      return { ...command, prefix, owner, path: source.path }
    }))
  }
  const coreCommandNames = (session: AgentSession): Set<string> => new Set([
    ...BUILTINS.flatMap(command => [command.name, ...(command.aliases ?? [])]),
    ...session.resourceLoader.getPrompts().prompts.map(prompt => prompt.name)
  ])

  const runBuiltinPluginCommand = async (command: typeof pluginCommands[number], argument: string) => {
    try {
      const handler = pluginHandlers.get(`${command.pluginId}:${command.name}`)
      if (!handler) throw new Error(`No terminal handler for built-in plugin command ${command.pluginId}:${command.name}.`)
      await handler(argument)
      host.refresh()
    } catch (error) { host.ui.notify(error instanceof Error ? error.message : String(error), 'error') }
  }

  const runExtensionCommand = async (registered: ExtensionCommand, argument: string, route: string) => {
    try {
      const command = host.session().extensionRunner.getCommand(registered.invocationName)
      if (!command) throw new Error(`Plugin command /${route} is no longer registered. Reload trusted resources.`)
      await command.handler(argument, host.session().extensionRunner.createCommandContext())
      host.refresh()
    } catch (error) { host.ui.notify(error instanceof Error ? error.message : String(error), 'error') }
  }

  const runLegacyPluginCommand = async (name: string, argument: string): Promise<void> => {
    const session = host.session()
    if (coreCommandNames(session).has(name)) {
      host.ui.notify(`Use /${name}; /plugin:${name} is unavailable because a core command or prompt already uses that name.`, 'error')
      return
    }
    const builtins = BUILTIN_PLUGIN_REGISTRY.commandsNamed(name)
    const extensions = extensionCommands()
    if (builtins.length > 1) {
      host.ui.notify(`Legacy plugin command /plugin:${name} is ambiguous. Use its owner-qualified command.`, 'error')
      return
    }
    if (builtins.length === 1) {
      const competitors = extensions.byName.get(name) ?? []
      if (competitors.length) {
        host.ui.notify(`Extension command /plugin:${name} from ${competitors.map(command => command.sourceInfo.path).join(', ')} is unavailable because the name belongs to the built-in ${builtins[0]!.pluginId} plugin.`, 'error')
      }
      await runBuiltinPluginCommand(builtins[0]!, argument)
      return
    }
    const matches = extensions.byName.get(name) ?? []
    if (matches.length > 1) {
      host.ui.notify(`Legacy plugin command /plugin:${name} is ambiguous. Registered by: ${matches.map(command => command.sourceInfo.path).join(', ')}. Use its owner-qualified command.`, 'error')
      return
    }
    if (matches.length === 1) {
      if (extensions.conflictingPrefixes.has(matches[0]!.prefix)) {
        host.ui.notify(`Plugin prefix /${matches[0]!.prefix}: is ambiguous or reserved. Owners: ${extensions.conflictingPrefixes.get(matches[0]!.prefix)!.join(', ')}.`, 'error')
        return
      }
      await runExtensionCommand(matches[0]!, argument, `plugin:${name}`)
      return
    }
    host.ui.notify(`Unknown plugin command: /plugin:${name}. Use /help to list the commands.`, 'error')
  }

  const runNamespacedCommand = async (typedName: string, argument: string): Promise<boolean> => {
    const separator = typedName.indexOf(':')
    if (separator < 1) return false
    const prefix = typedName.slice(0, separator)
    const name = typedName.slice(separator + 1)
    if (prefix === 'plugin') {
      await runLegacyPluginCommand(name, argument)
      return true
    }
    const builtin = name ? BUILTIN_PLUGIN_REGISTRY.command(prefix, name) : BUILTIN_PLUGIN_REGISTRY.defaultCommand(prefix)
    const extensions = extensionCommands()
    const isBuiltinPrefix = builtinPrefixes.has(prefix)
    const isExtensionPrefix = extensions.ownersByPrefix.has(prefix)
    if (!builtin && !isBuiltinPrefix && !isExtensionPrefix) return false
    if (builtin) {
      const competitors = extensions.routes.get(`${prefix}:${builtin.name}`) ?? []
      if (competitors.length) {
        host.ui.notify(`Extension command /${prefix}:${builtin.name} from ${competitors.map(command => command.sourceInfo.path).join(', ')} is unavailable because the prefix belongs to built-in ${builtin.pluginId}.`, 'error')
      }
      await runBuiltinPluginCommand(builtin, argument)
      return true
    }
    if (extensions.conflictingPrefixes.has(prefix)) {
      host.ui.notify(`Plugin prefix /${prefix}: is ambiguous or reserved. Owners: ${extensions.conflictingPrefixes.get(prefix)!.join(', ')}.`, 'error')
      return true
    }
    if (!name) {
      host.ui.notify(`Plugin /${prefix}: has no default command. Use /help to list its commands.`, 'error')
      return true
    }
    const matches = extensions.routes.get(`${prefix}:${name}`) ?? []
    if (matches.length > 1) {
      host.ui.notify(`Plugin command /${prefix}:${name} is ambiguous. Registered by: ${matches.map(command => command.sourceInfo.path).join(', ')}.`, 'error')
      return true
    }
    if (matches.length === 1) {
      await runExtensionCommand(matches[0]!, argument, `${prefix}:${name}`)
      return true
    }
    host.ui.notify(`Unknown plugin command: /${typedName}. Use /help to list the commands.`, 'error')
    return true
  }

  const legacyAliases = (): string[] => {
    const session = host.session()
    const coreNames = coreCommandNames(session)
    const aliases = new Set<string>(LEGACY_BUILTIN_COMMAND_ALIASES.keys())
    for (const command of pluginCommands) {
      if (command.rootOnly || coreNames.has(command.name)) continue
      aliases.add(`plugin:${command.name}`)
      if (command.legacyBare) aliases.add(command.name)
    }
    for (const name of extensionCommands().byName.keys()) {
      if (!coreNames.has(name)) aliases.add(`plugin:${name}`)
    }
    return [...aliases]
  }

  const completions = (): TerminalCommandCompletion[] => {
    const session = host.session()
    const prompts = session.resourceLoader.getPrompts().prompts
    const commands = new Map(BUILTINS.map(command => [command.name, command]))
    for (const command of pluginCommands) {
      if (command.rootOnly) continue
      const invocation = `${command.prefix}:${command.name}`
      commands.set(invocation, { name: invocation, description: command.description, group: 'Plugins' })
    }
    for (const module of BUILTIN_PLUGIN_REGISTRY.modules) {
      const defaultCommand = module.defaultCommand && BUILTIN_PLUGIN_REGISTRY.defaultCommand(module.commandPrefix ?? module.descriptor.id)
      if (defaultCommand) {
        const invocation = `${defaultCommand.prefix}:`
        commands.set(invocation, { name: invocation, description: defaultCommand.description, group: 'Plugins' })
      }
    }
    const extensions = extensionCommands()
    for (const [route, matches] of extensions.routes) {
      const prefix = route.slice(0, route.indexOf(':'))
      if (matches.length !== 1 || extensions.conflictingPrefixes.has(prefix)) continue
      if (BUILTIN_PLUGIN_REGISTRY.command(prefix, matches[0]!.name)) continue
      commands.set(route, { name: route, description: matches[0]!.description, group: 'Plugins' })
    }
    const extensionNames = new Set(extensions.byName.keys())
    for (const prompt of prompts) {
      if (promptCommandAvailable(prompt.name, new Set([...commands.keys(), ...COMMAND_ALIASES.keys()]), extensionNames)) commands.set(prompt.name, { name: prompt.name, description: prompt.description, group: 'Prompts' })
    }
    return [...commands.values()]
  }

  async function execute(text: string): Promise<boolean> {
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
    if (!match) return false
    const typedName = match[1]!
    const argument = match[2]?.trim() ?? ''
    const legacyBuiltin = LEGACY_BUILTIN_COMMAND_ALIASES.get(typedName)
    if (!legacyBuiltin && await runNamespacedCommand(typedName, argument)) return true
    const session = host.session()
    const name = coreCommand(legacyBuiltin ?? typedName)?.name ?? legacyBuiltin ?? typedName
    const builtin = BUILTINS.find(item => item.name === name)
    if (!builtin && !coreCommandNames(session).has(name)) {
      const legacyBare = BUILTIN_PLUGIN_REGISTRY.commandsNamed(name).filter(command => command.legacyBare)
      if (legacyBare.length > 1) {
        host.ui.notify(`Legacy command /${name} is ambiguous. Use its owner-qualified command.`, 'error')
        return true
      }
      if (legacyBare.length === 1) {
        await runBuiltinPluginCommand(legacyBare[0]!, argument)
        return true
      }
    }
    if (!builtin) {
      // A skill is offered as $name; the typed /skill:name form still reaches the SDK, which expands it.
      if (skills().some(skill => `skill:${skill.name}` === name)) return false
      const prompt = session.resourceLoader.getPrompts().prompts.some(item => item.name === name)
      if (prompt && promptCommandAvailable(name, CORE_PROMPT_NAMES, new Set(extensionCommands().byName.keys()))) return false
      host.ui.notify(`Unknown command: /${name}. Use /help to list commands.`, 'error')
      return true
    }
    try {
      switch (name) {
        case 'help': host.showHelp(groupTerminalCommands(completions())); break
        case 'plan': {
          if (!argument || ['on', 'off', 'toggle'].includes(argument.toLowerCase())) throw new Error('Use /plan <plan brief>.')
          host.plan(argument)
          break
        }
        case 'quit': host.shutdown(); break
        case 'btw': await host.btw(argument); break
        case 'stop': {
          if (session.isIdle) throw new Error('Nothing is running.')
          await host.runtime().interrupt()
          break
        }
        case 'new': await host.runtime().newSession(); break
        case 'session': {
          let path = argument
          if (!path) {
            const selected = await host.ui.custom<string | undefined>((tui, _theme, _keys, done) => {
              const page = new ResumeSessionsPage({
                theme: () => host.ui.theme,
                cwd: () => host.cwd(),
                branch: () => host.branch(),
                listSessions: signal => SessionManager.list(host.cwd(), host.sessionDirectory(), undefined, signal),
                select: done,
                cancel: () => done(undefined),
                changed: host.changed
              })
              return new PageOverlay({ page, tui, theme: () => host.ui.theme, close: () => done(undefined), changed: host.changed })
            }, { overlay: true, overlayOptions: pageOverlayOptions('fullscreen') })
            if (!selected) break
            path = selected
          }
          const target = resolve(host.cwd(), path)
          const within = relative(host.sessionDirectory(), target)
          if (within === '..' || within.startsWith('../') || within.startsWith('..\\') || isAbsolute(within)) {
            throw new Error('Resume sessions from this account history folder.')
          }
          await host.runtime().switchSession(target)
          break
        }
        case 'fork': {
          const message = await choose('Fork before message', session.getUserMessagesForForking(), (item, index) => `${index + 1}. ${item.text.replace(/\s+/g, ' ').slice(0, 160)}`)
          if (message) {
            const result = await host.runtime().fork(message.entryId)
            if (!result.cancelled && result.selectedText) host.setEditorText(result.selectedText)
          }
          break
        }
        case 'clone': {
          const leaf = session.sessionManager.getLeafId()
          if (!leaf) throw new Error('Nothing to clone yet')
          const result = await host.runtime().fork(leaf, { position: 'at' })
          if (!result.cancelled) { host.setEditorText(''); notify('Cloned to new session') }
          break
        }
        case 'history': {
          const tree = session.sessionManager.getTree()
          if (!tree.length) throw new Error('No entries in this session')
          const selected = await host.ui.custom<string | undefined>((tui, _theme, keys, done) => new TreePicker({
            theme: () => host.ui.theme, tui, matches: (data, action) => keys.matches(data, action as never),
            tree, currentLeafId: session.sessionManager.getLeafId(), initialFilterMode: session.settingsManager.getTreeFilterMode(),
            select: done, cancel: () => done(undefined),
            copy: text => { void host.copyText(text).catch(error => host.ui.notify(String(error), 'error')) },
            editLabel: (_entryId, current) => host.ui.editor('Label (empty to remove)', current),
            labelChanged: (entryId, label) => { session.sessionManager.appendLabelChange(entryId, label) },
            changed: host.changed
          }), { overlay: true, overlayOptions: pageOverlayOptions() })
          if (selected && selected !== session.sessionManager.getLeafId()) {
            const summarize = await host.ui.confirm('Navigate session', 'Summarize the abandoned branch before navigating?')
            const result = await host.runtime().navigateTree(selected, { summarize })
            if (!result.cancelled && result.editorText) host.setEditorText(result.editorText)
          }
          break
        }
        case 'effort': {
          const levels = session.getAvailableThinkingLevels()
          const level = argument || await host.ui.select('Thinking effort', levels)
          if (!level) break
          if (!levels.includes(level as AgentSession['thinkingLevel'])) throw new Error(`Available thinking levels: ${levels.join(', ')}`)
          session.setThinkingLevel(level as AgentSession['thinkingLevel'], { persist: true })
          break
        }
        case 'thinking': {
          const settings = session.settingsManager
          const current = settings.getHideThinkingBlock()
          const mode = argument.toLowerCase()
          if (mode && mode !== 'show' && mode !== 'hide') throw new Error('Use /thinking, /thinking show, or /thinking hide.')
          const hidden = mode ? mode === 'hide' : !current
          if (hidden !== current) settings.setHideThinkingBlock(hidden)
          notify(`Thinking blocks ${hidden ? 'hidden' : 'shown'}.`)
          break
        }
        case 'model': {
          const provider = session.settingsManager.getDefaultProvider()
          const id = session.settingsManager.getDefaultModel()
          const selected = await host.ui.custom<{ model: NonNullable<AgentSession['model']>; persist: boolean } | undefined>((tui, _theme, _keys, done) =>
            new ModelPicker({
              theme: () => host.ui.theme, tui, runtime: session.modelRuntime, current: session.model, scoped: session.scopedModels,
              defaultModel: provider && id ? { provider, id } : undefined, initialSearch: argument || undefined,
              select: (model, persist) => done({ model, persist }), cancel: () => done(undefined), changed: host.changed
            }), { overlay: true, overlayOptions: pageOverlayOptions() })
          if (selected) await session.setModel(selected.model, { persist: selected.persist })
          break
        }
        case 'settings': await openPage('settings'); break
        case 'doctor': await openPage('doctor'); break
        case 'worktree': await openPage('worktree'); break
        case 'trajectory': await openPage('trajectory', { runId: argument }); break
        case 'todo': {
          const items = await host.todo()
          if (!items.length) notify('No todo list in this reply yet. The agent writes one with todo_write for multi-step work.')
          else host.showTodo(items)
          break
        }
        case 'subagents': await openPage('subagents'); break
        case 'agents': await openPage('agents'); break
        case 'permissions': await openPage('permissions'); break
        case 'accounts': await openPage('accounts'); break
        case 'harness': await openPage('harness'); break
        case 'skills': await openPage('skills'); break
        case 'connections':
        case 'mcp': await openPage('connections'); break
        case 'tools': await openPage('tools'); break
        case 'plugins': await openPage('plugins'); break
        case 'hub': await openPage('hub'); break
        case 'components': await openPage('components'); break
        case 'name': {
          const name = argument || await host.ui.input('Session name', session.sessionName)
          if (name !== undefined) session.setSessionName(name)
          break
        }
        case 'log': await openPage('log'); break
        case 'compact': await session.compact(argument || undefined); break
        case 'reload': await host.runtime().reload(); notify('Trusted resources reloaded'); break
        case 'copy': {
          const response = session.getLastAssistantText()
          if (!response) throw new Error('No assistant response to copy yet')
          await host.copyText(response)
          notify('Copied last assistant response')
          break
        }
        case 'export': {
          const output = argument || await host.ui.input('Export path (.html or .jsonl)', 'session.html')
          if (!output) break
          const path = resolve(host.cwd(), output)
          notify(`Exported to ${path.endsWith('.jsonl') ? session.exportToJsonl(path) : await session.exportToHtml(path, { themeName: host.ui.theme.name })}`)
          break
        }
        case 'hotkeys': notify(host.hotkeys?.() ?? 'Keyboard bindings are managed by the terminal application.'); break
      }
      host.refresh()
    } catch (error) { host.ui.notify(error instanceof Error ? error.message : String(error), 'error') }
    return true
  }
  return { execute, completions, skills, legacyAliases }
}
