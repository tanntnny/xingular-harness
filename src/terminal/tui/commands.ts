import { isAbsolute, relative, resolve } from 'node:path'
import { SessionManager, type AgentSession, type ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { BUILTIN_PLUGIN_REGISTRY } from '../../plugins/builtin'
import { PageOverlay } from './pageOverlay'
import { ModelPicker } from './modelPicker'
import { TreePicker } from './treePicker'
import type { AnnotateStart } from './pages/annotatePage'
import { createCommandPage, type CommandPageId } from './commandPages'
import { pageOverlayOptions } from './dialogGeometry'
import { expandSkillInvocation, type SkillEntry } from './skillInvocation'
import type { TerminalRuntime } from './runtime'
import type { TerminalTrajectoryRun, TerminalTrajectorySnapshot } from '../trajectory'
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
  sessionDirectory(): string
  refresh(): void
  changed(): void
  showHelp(groups: TerminalCommandHelpGroup[]): void
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

const BUILTINS: TerminalCommandCompletion[] = [
  { name: 'help', description: 'List the commands', group: 'Core' },
  { name: 'plan', description: 'Plan one request, read-only: /plan <brief>', group: 'Run' },
  { name: 'btw', aliases: ['side'], description: 'Ask a side question without interrupting: /btw <question>', group: 'Run' },
  { name: 'new', description: 'Start a new session', group: 'Session' },
  { name: 'stop', description: 'Stop the current reply', group: 'Run' },
  { name: 'session', aliases: ['resume'], description: 'Choose a saved session in this account and folder', group: 'Session' },
  { name: 'history', aliases: ['tree'], description: 'Navigate branches in the current session', group: 'Session' },
  { name: 'fork', description: 'Fork from an earlier message', group: 'Session' },
  { name: 'clone', description: 'Clone this branch into a new session', group: 'Session' },
  { name: 'model', description: 'Choose the model', group: 'Model' },
  { name: 'effort', description: 'Choose the thinking effort', group: 'Model' },
  { name: 'thinking', description: 'Toggle transcript thinking visibility: /thinking [show|hide]', group: 'Model' },
  { name: 'name', description: 'Name this session', group: 'Session' },
  { name: 'compact', description: 'Compact the context', group: 'Session' },
  { name: 'copy', description: 'Copy the last reply', group: 'Inspect' },
  { name: 'export', description: 'Export this branch to HTML or JSONL', group: 'Inspect' },
  { name: 'reload', description: 'Reload trusted resources and keybindings', group: 'Harness' },
  { name: 'accounts', description: 'Sign in, switch, check and remove Pi accounts', group: 'Harness' },
  { name: 'permissions', description: 'Full Permission and per-tool approvals', group: 'Harness' },
  { name: 'harness', description: 'Browse foundation, variant and all resources', group: 'Harness' },
  { name: 'skills', description: 'View, inspect and use skills; discover more', group: 'Harness' },
  { name: 'connections', description: 'Manage local and remote MCP connections', group: 'Harness' },
  { name: 'mcp', description: 'Open Connections in the Harness browser', group: 'Harness' },
  { name: 'tools', description: 'Inspect available tools, owners and approvals', group: 'Harness' },
  { name: 'plugins', description: 'Switch plugins on or off and trust their code', group: 'Harness' },
  { name: 'hub', description: 'Browse and install reviewed skills, plugins and documents', group: 'Harness' },
  { name: 'components', description: 'Browse skills, prompts and rules for this Harness scope', group: 'Harness' },
  { name: 'settings', description: 'Session, terminal and browser settings', group: 'Harness' },
  { name: 'log', description: "Harness diagnostics and this conversation's run events", group: 'Inspect' },
  { name: 'hotkeys', description: 'Keyboard controls', group: 'Core' },
  { name: 'quit', description: 'Restore the terminal and exit', group: 'Core' }
]

const COMMAND_ALIASES = new Map(BUILTINS.flatMap(command => (command.aliases ?? []).map(alias => [alias, command.name] as const)))

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
  /** The text to send: a leading `$name` of a loaded skill becomes the `/skill:name` form Pi expands. */
  const expandSkill = (text: string): string => expandSkillInvocation(text, new Set(skills().map((skill) => skill.name)))

  async function openPage(id: CommandPageId, options: { runId?: string; url?: string; annotate?: AnnotateStart } = {}) {
    let close = () => {}
    const page = createCommandPage(host, id, { ...options, close: () => close() })
    await host.ui.custom<void>((tui, _theme, _keys, done) => {
      close = () => done(undefined)
      return new PageOverlay({ page, tui, theme: () => host.ui.theme, close, changed: host.changed })
    }, { overlay: true, overlayOptions: pageOverlayOptions(page.presentation) })
  }

  const pluginHandlers = createBuiltinPluginCommandHandlers(host, openPage)
  const pluginCommands = BUILTIN_PLUGIN_REGISTRY.commands()
  const coreNames = new Set([...BUILTINS.map(command => command.name), ...COMMAND_ALIASES.keys()])
  for (const command of pluginCommands) {
    if (command.namespace === 'unprefixed' && coreNames.has(command.name)) {
      throw new Error(`Required plugin command collides with a core command: ${command.pluginId}:${command.name}`)
    }
  }
  const extensionCommands = () => {
    const byName = new Map<string, ReturnType<AgentSession['extensionRunner']['getRegisteredCommands']>[number][]>()
    for (const command of host.session().extensionRunner.getRegisteredCommands()) {
      byName.set(command.name, [...(byName.get(command.name) ?? []), command])
    }
    const unique = new Map<string, ReturnType<AgentSession['extensionRunner']['getRegisteredCommands']>[number]>()
    const duplicates = new Map<string, ReturnType<AgentSession['extensionRunner']['getRegisteredCommands']>[number][]>()
    for (const [name, commands] of byName) {
      if (commands.length === 1) unique.set(name, commands[0]!)
      else duplicates.set(name, commands)
    }
    return { unique, duplicates }
  }
  const unprefixedCommandNames = (session: AgentSession): Set<string> => new Set([
    ...BUILTINS.flatMap(command => [command.name, ...(command.aliases ?? [])]),
    ...pluginCommands.filter(command => command.namespace === 'unprefixed').map(command => command.name),
    ...session.resourceLoader.getPrompts().prompts.map(prompt => prompt.name)
  ])

  const runBuiltinPluginCommand = async (name: string, argument: string) => {
    try {
      const handler = pluginHandlers.get(name)
      if (!handler) throw new Error(`No terminal handler for built-in plugin command ${name}.`)
      await handler(argument)
      host.refresh()
    } catch (error) { host.ui.notify(error instanceof Error ? error.message : String(error), 'error') }
  }

  const completions = (): TerminalCommandCompletion[] => {
    const session = host.session()
    const prompts = session.resourceLoader.getPrompts().prompts
    const commands = new Map(BUILTINS.map(command => [command.name, command]))
    const bareNames = unprefixedCommandNames(session)
    const namespacedBuiltins = new Set<string>()
    for (const command of pluginCommands) {
      if (command.namespace === 'unprefixed') {
        commands.set(command.name, { name: command.name, description: command.description, group: 'Harness' })
      } else {
        namespacedBuiltins.add(command.name)
        if (!bareNames.has(command.name)) {
          const invocation = `plugin:${command.name}`
          commands.set(invocation, { name: invocation, description: command.description, group: 'Plugins' })
        }
      }
    }
    const extensions = extensionCommands()
    for (const [name, command] of extensions.unique) {
      if (!bareNames.has(name) && !namespacedBuiltins.has(name)) {
        const invocation = `plugin:${name}`
        commands.set(invocation, { name: invocation, description: command.description, group: 'Plugins' })
      }
    }
    for (const prompt of prompts) {
      if (!commands.has(prompt.name) && !COMMAND_ALIASES.has(prompt.name)) commands.set(prompt.name, { name: prompt.name, description: prompt.description, group: 'Prompts' })
    }
    return [...commands.values()]
  }

  async function execute(text: string): Promise<boolean> {
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
    if (!match) return false
    const typedName = match[1]!
    const argument = match[2]?.trim() ?? ''
    if (typedName.startsWith('plugin:')) {
      const pluginName = typedName.slice('plugin:'.length)
      const session = host.session()
      if (unprefixedCommandNames(session).has(pluginName)) {
        host.ui.notify(`Use /${pluginName}; /plugin:${pluginName} is unavailable because an unprefixed command already uses that name.`, 'error')
        return true
      }
      const builtin = BUILTIN_PLUGIN_REGISTRY.command(pluginName)
      const extensions = extensionCommands()
      if (builtin?.namespace === 'plugin') {
        const collisions = extensions.unique.get(pluginName) ? [extensions.unique.get(pluginName)!] : extensions.duplicates.get(pluginName) ?? []
        if (collisions.length) {
          const owners = collisions.map(command => command.sourceInfo.path).join(', ')
          host.ui.notify(`Extension command /plugin:${pluginName} from ${owners} is unavailable because the name belongs to the built-in ${builtin.pluginId} plugin.`, 'error')
        }
        await runBuiltinPluginCommand(pluginName, argument)
        return true
      }
      const duplicate = extensions.duplicates.get(pluginName)
      if (duplicate) {
        const owners = duplicate.map(command => command.sourceInfo.path).join(', ')
        host.ui.notify(`Plugin command /plugin:${pluginName} is ambiguous. Registered by: ${owners}. Rename or remove one command.`, 'error')
        return true
      }
      const registered = extensions.unique.get(pluginName)
      if (registered) {
        try {
          const command = host.session().extensionRunner.getCommand(registered.invocationName)
          if (!command) throw new Error(`Plugin command /plugin:${pluginName} is no longer registered. Reload trusted resources.`)
          await command.handler(argument, host.session().extensionRunner.createCommandContext())
          host.refresh()
        } catch (error) { host.ui.notify(error instanceof Error ? error.message : String(error), 'error') }
        return true
      }
      host.ui.notify(`Unknown plugin command: /${typedName}. Use /help to list the commands.`, 'error')
      return true
    }
    const name = COMMAND_ALIASES.get(typedName) ?? typedName
    const builtin = BUILTINS.find(item => item.name === name)
    const requiredPluginCommand = BUILTIN_PLUGIN_REGISTRY.command(name)
    if (!builtin && requiredPluginCommand?.namespace === 'unprefixed') {
      await runBuiltinPluginCommand(name, argument)
      return true
    }
    if (!builtin) {
      // A skill is offered as $name; the typed /skill:name form still reaches the SDK, which expands it.
      if (skills().some(skill => `skill:${skill.name}` === name)) return false
      if (host.session().resourceLoader.getPrompts().prompts.some(prompt => prompt.name === name)) return false
      host.ui.notify(`Unknown command: /${name}. Use /help to list commands.`, 'error')
      return true
    }
    try {
      const session = host.session()
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
          if (!session.isStreaming) throw new Error('Nothing is running.')
          await host.runtime().interrupt()
          break
        }
        case 'new': await host.runtime().newSession(); break
        case 'session': {
          let path = argument
          if (!path) {
            const sessions = await SessionManager.list(host.cwd(), host.sessionDirectory())
            const selected = await choose('Resume session', sessions, (item, index) => `${index + 1}. ${item.name ?? item.firstMessage ?? item.id}  ${item.modified.toLocaleString()}`)
            if (!selected) break
            path = selected.path
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
  return { execute, completions, skills, expandSkill }
}
