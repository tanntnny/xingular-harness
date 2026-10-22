import { isAbsolute, relative, resolve } from 'node:path'
import { SessionManager, type AgentSession, type ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { PageOverlay } from './pageOverlay'
import { ModelPicker } from './modelPicker'
import { TreePicker } from './treePicker'
import { createCommandPage, type CommandPageId } from './commandPages'
import { pageOverlayOptions } from './dialogGeometry'
import { expandSkillInvocation, type SkillEntry } from './skillInvocation'
import type { TerminalRuntime } from './runtime'
import type { TerminalTrajectoryRun, TerminalTrajectorySnapshot } from '../trajectory'

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
  plan(brief: string): void
  /** Asks a side question in its own tool-free session; empty text dismisses the one showing. */
  btw(question: string): Promise<void>
  shutdown(): void
  setEditorText(text: string): void
  copyText(text: string): Promise<void>
  suspend?(): Promise<void>
  hotkeys?(): string
  logs: { read(): Promise<string> }
  trajectory: {
    list(): Promise<TerminalTrajectoryRun[]>
    read(runId: string, afterSequence?: number): Promise<TerminalTrajectorySnapshot>
  }
}

export interface TerminalCommandCompletion { name: string; description?: string }

const BUILTINS: TerminalCommandCompletion[] = [
  { name: 'help', description: 'List the commands' },
  { name: 'plan', description: 'Plan one request, read-only: /plan <brief>' },
  { name: 'btw', description: 'Ask a side question without interrupting: /btw <question>' },
  { name: 'new', description: 'Start a new session' },
  { name: 'stop', description: 'Stop the current reply' },
  { name: 'resume', description: 'Resume a session in this account and folder' },
  { name: 'tree', description: 'Navigate the session tree' },
  { name: 'fork', description: 'Fork from an earlier message' },
  { name: 'clone', description: 'Clone this branch into a new session' },
  { name: 'model', description: 'Choose the model' },
  { name: 'effort', description: 'Choose the thinking effort' },
  { name: 'thinking', description: 'Toggle transcript thinking visibility: /thinking [show|hide]' },
  { name: 'name', description: 'Name this session' },
  { name: 'compact', description: 'Compact the context' },
  { name: 'copy', description: 'Copy the last reply' },
  { name: 'export', description: 'Export this branch to HTML or JSONL' },
  { name: 'reload', description: 'Reload trusted resources and keybindings' },
  { name: 'accounts', description: 'Sign in, switch, check and remove Pi accounts' },
  { name: 'permissions', description: 'Full Permission and per-tool approvals' },
  { name: 'plugins', description: 'Switch plugins on or off and trust their code' },
  { name: 'hub', description: 'Browse and install reviewed skills, plugins and documents' },
  { name: 'components', description: 'Browse skills, prompts and rules for this Harness scope' },
  { name: 'settings', description: 'Session and terminal settings' },
  { name: 'trajectory', description: 'Inspect the recorded runs of this session' },
  { name: 'log', description: "Harness diagnostics and this conversation's run events" },
  { name: 'hotkeys', description: 'Keyboard controls' },
  { name: 'quit', description: 'Restore the terminal and exit' }
]

export function createTerminalCommands(host: TerminalCommandHost) {
  const notify = (text: string) => host.ui.notify(text, 'info')
  const choose = async <T>(title: string, items: T[], label: (item: T, index: number) => string) => {
    const labels = items.map(label)
    const selected = await host.ui.select(title, labels)
    return selected === undefined ? undefined : items[labels.indexOf(selected)]
  }
  const completions = (): TerminalCommandCompletion[] => {
    const session = host.session()
    const commands = new Map(BUILTINS.map(command => [command.name, command]))
    for (const command of session.extensionRunner.getRegisteredCommands()) {
      if (!commands.has(command.name)) commands.set(command.name, { name: command.name, description: command.description })
    }
    for (const prompt of session.resourceLoader.getPrompts().prompts) {
      if (!commands.has(prompt.name)) commands.set(prompt.name, { name: prompt.name, description: prompt.description })
    }
    return [...commands.values()]
  }
  /** The skills this session may be asked to use, each invoked as `$name`. Off with the "Skill commands" setting. */
  const skills = (): SkillEntry[] => {
    const session = host.session()
    if (!session.settingsManager.getEnableSkillCommands()) return []
    return session.resourceLoader.getSkills().skills.map((skill) => ({ name: skill.name, description: skill.description }))
  }
  /** The text to send: a leading `$name` of a loaded skill becomes the `/skill:name` form Pi expands. */
  const expandSkill = (text: string): string => expandSkillInvocation(text, new Set(skills().map((skill) => skill.name)))

  async function openPage(id: CommandPageId, options: { runId?: string } = {}) {
    await host.ui.custom<void>((tui, _theme, _keys, done) => new PageOverlay({
      page: createCommandPage(host, id, options), tui, theme: () => host.ui.theme,
      close: () => done(undefined), changed: host.changed
    }), { overlay: true, overlayOptions: pageOverlayOptions() })
  }

  async function execute(text: string): Promise<boolean> {
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
    if (!match) return false
    const name = match[1]!
    const argument = match[2]?.trim() ?? ''
    if (!BUILTINS.some(item => item.name === name)) {
      if (completions().some(item => item.name === name)) return false
      // A skill is offered as $name; the typed /skill:name form still reaches the SDK, which expands it.
      if (skills().some(skill => `skill:${skill.name}` === name)) return false
      host.ui.notify(`Unknown command: /${name}. Use /help to list commands.`, 'error')
      return true
    }
    try {
      const session = host.session()
      switch (name) {
        case 'help': notify(completions().map(item => `/${item.name}  ${item.description ?? ''}`).join('\n')); break
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
        case 'resume': {
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
        case 'tree': {
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
        case 'plugins': await openPage('plugins'); break
        case 'hub': await openPage('hub'); break
        case 'components': await openPage('components'); break
        case 'name': {
          const name = argument || await host.ui.input('Session name', session.sessionName)
          if (name !== undefined) session.setSessionName(name)
          break
        }
        case 'trajectory': await openPage('trajectory', { runId: argument }); break
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
