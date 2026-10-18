import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { ModelSelectorComponent, TreeSelectorComponent, SessionManager, type AgentSession, type ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { SettingsPanel, type TerminalSettingItem } from './settings'
import { DialogPanel, SearchableSelect } from './dialogs'
import { TrajectoryPanel } from './trajectoryPanel'
import { expandSkillInvocation, type SkillEntry } from './skillInvocation'
import manifest from '../../../package.json'
import type { TerminalRuntime } from './runtime'
import type { TerminalTrajectoryRun, TerminalTrajectorySnapshot } from '../trajectory'

export interface TerminalCommandHost {
  session(): AgentSession
  /** Navigation is scope checked by the Harness runtime adapter. */
  runtime(): Pick<TerminalRuntime, 'newSession' | 'switchSession' | 'fork' | 'importFromJsonl' | 'reload' | 'navigateTree' | 'installationDeviceId' | 'permissions' | 'setFullPermission' | 'setGlobalTool'>
  ui: ExtensionUIContext
  cwd(): string
  sessionDirectory(): string
  refresh(): void
  changed(): void
  planMode(): boolean
  setPlanMode(enabled: boolean): void
  shutdown(): void
  setEditorText(text: string): void
  copyText(text: string): Promise<void>
  secretInput?(title: string, placeholder?: string, options?: { signal?: AbortSignal }): Promise<string | undefined>
  openExternal?(url: string): Promise<void>
  suspend?(): Promise<void>
  hotkeys?(): string
  changelog?(): Promise<string>
  trajectory: {
    list(): Promise<TerminalTrajectoryRun[]>
    read(runId: string, afterSequence?: number): Promise<TerminalTrajectorySnapshot>
  }
}

export interface TerminalCommandCompletion { name: string; description?: string }

const BUILTINS: TerminalCommandCompletion[] = [
  { name: 'help', description: 'Available terminal commands' },
  { name: 'plan', description: 'Toggle read-only plan mode' },
  { name: 'new', description: 'Start a new session' },
  { name: 'resume', description: 'Resume a session in this account and folder' },
  { name: 'tree', description: 'Navigate the session tree' },
  { name: 'fork', description: 'Fork from a user message' },
  { name: 'model', description: 'Choose a model' },
  { name: 'effort', description: 'Choose thinking effort' },
  { name: 'clone', description: 'Clone the current branch to a new session' },
  { name: 'scoped-models', description: 'Choose models for cycling' },
  { name: 'settings', description: 'Session and terminal settings' },
  { name: 'permissions', description: 'Review and change terminal approval permissions' },
  { name: 'name', description: 'Name the current session' },
  { name: 'session', description: 'Current session statistics' },
  { name: 'trajectory', description: 'Inspect recorded runs for this native session' },
  { name: 'compact', description: 'Compact the current context' },
  { name: 'reload', description: 'Reload trusted resources and keyboard bindings' },
  { name: 'trust', description: 'Review plugin code and project trust' },
  { name: 'bug', description: 'Open a Harness issue draft' },
  { name: 'login', description: 'Sign in to a provider in this isolated account' },
  { name: 'logout', description: 'Remove a stored provider credential' },
  { name: 'export', description: 'Export this branch to HTML or JSONL' },
  { name: 'import', description: 'Import a session JSONL file' },
  { name: 'share', description: 'Share an HTML export as a secret GitHub gist' },
  { name: 'copy', description: 'Copy the last assistant response' },
  { name: 'changelog', description: 'Harness release notes' },
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

  async function settings() {
    const session = host.session()
    const settings = session.settingsManager
    const booleanSettings = [
      ['Auto compaction', () => session.autoCompactionEnabled, (value: boolean) => session.setAutoCompactionEnabled(value)],
      ['Auto retry', () => session.autoRetryEnabled, (value: boolean) => session.setAutoRetryEnabled(value)],
      ['Show images', () => settings.getShowImages(), (value: boolean) => settings.setShowImages(value)],
      ['Resize images', () => settings.getImageAutoResize(), (value: boolean) => settings.setImageAutoResize(value)],
      ['Block images', () => settings.getBlockImages(), (value: boolean) => settings.setBlockImages(value)],
      ['Skill commands', () => settings.getEnableSkillCommands(), (value: boolean) => settings.setEnableSkillCommands(value)],
      ['Hide thinking', () => settings.getHideThinkingBlock(), (value: boolean) => settings.setHideThinkingBlock(value)],
      ['Hardware cursor', () => settings.getShowHardwareCursor(), (value: boolean) => settings.setShowHardwareCursor(value)],
      ['Terminal progress', () => settings.getShowTerminalProgress(), (value: boolean) => settings.setShowTerminalProgress(value)]
    ] as const
    let selectedId: string | undefined
    const locations = [
      ['Context', 'Compaction'], ['Model', 'Recovery'], ['Appearance', 'Images'], ['Appearance', 'Images'],
      ['Context', 'Images'], ['Interaction', 'Commands'], ['Appearance', 'Display'], ['Interaction', 'Editor'],
      ['Interaction', 'Terminal'], ['Model', 'Thinking'], ['Interaction', 'Queues'], ['Interaction', 'Queues'],
      ['Appearance', 'Theme'], ['Interaction', 'Keyboard']
    ]
    for (;;) {
      const options = [...booleanSettings.map(([label, get]) => `${label}: ${get() ? 'on' : 'off'}`),
        `Thinking: ${session.thinkingLevel}`, `Steering: ${session.steeringMode}`, `Follow-up: ${session.followUpMode}`,
        `Theme: ${host.ui.theme.name}`, 'Keyboard controls', 'Done']
      const descriptions = [
        'Compact the context automatically when the session approaches its limit.', 'Retry eligible provider failures automatically.',
        'Display actual image content returned by tools.', 'Resize image attachments before provider requests.',
        'Block image attachments in provider requests.', 'Expose commands for the skills loaded in this session.',
        'Collapse assistant thinking blocks in the transcript.', 'Display the terminal hardware cursor for editing and input methods.',
        'Report active work through supported terminal progress controls.', 'Reasoning effort for the current model.',
        'Delivery mode for messages that steer an active run.', 'Delivery mode for messages queued after a run.',
        'Theme loaded from the trusted resource catalog.', 'View the current application keyboard bindings.'
      ]
      const items: TerminalSettingItem[] = options.slice(0, -1).map((option, index) => {
        const split = option.indexOf(':')
        return { id: String(index), tab: locations[index][0], group: locations[index][1], label: split < 0 ? option : option.slice(0, split), value: split < 0 ? '' : option.slice(split + 1).trim(), description: descriptions[index] }
      })
      const groups = ['Theme', 'Display', 'Images', 'Thinking', 'Recovery', 'Editor', 'Queues', 'Commands', 'Terminal', 'Keyboard', 'Compaction']
      items.sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group))
      const id = await host.ui.custom<string | undefined>((tui, theme, _keys, done) => new SettingsPanel(tui, () => theme, items, done, selectedId), { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'top-left' } })
      if (id === undefined) return
      selectedId = id
      const index = Number(id)
      const selected = options[index]
      if (index < booleanSettings.length) {
        const [, get, set] = booleanSettings[index]!
        set(!get())
      } else if (selected.startsWith('Thinking:')) {
        const level = await host.ui.select('Thinking effort', session.getAvailableThinkingLevels())
        if (level) session.setThinkingLevel(level as AgentSession['thinkingLevel'], { persist: true })
      } else if (selected.startsWith('Steering:') || selected.startsWith('Follow-up:')) {
        const mode = await host.ui.select('Queue delivery', ['all', 'one-at-a-time'])
        if (mode === 'all' || mode === 'one-at-a-time') {
          if (selected.startsWith('Steering:')) session.setSteeringMode(mode)
          else session.setFollowUpMode(mode)
        }
      } else if (selected.startsWith('Theme:')) {
        const theme = await host.ui.select('Theme', host.ui.getAllThemes().map(item => item.name))
        if (theme) {
          const result = host.ui.setTheme(theme)
          if (!result.success) throw new Error(result.error)
          settings.setTheme(theme)
        }
      } else notify(host.hotkeys?.() ?? 'Use /help for commands. Keyboard bindings are managed by the terminal application.')
      host.refresh()
    }
  }

  async function login(providerRef: string) {
    const runtime = host.session().modelRuntime
    const providers = runtime.getProviders().filter(provider => provider.auth.oauth || provider.auth.apiKey?.login)
    const provider = providerRef
      ? providers.find(item => item.id === providerRef || item.name.toLowerCase() === providerRef.toLowerCase())
      : await choose('Sign in to provider', providers, item => `${item.name} (${item.id})`)
    if (!provider) { if (providerRef) throw new Error(`No sign-in provider matches ${providerRef}`); return }
    const types = [...(provider.auth.oauth ? ['oauth' as const] : []), ...(provider.auth.apiKey?.login ? ['api_key' as const] : [])]
    const type = types.length === 1 ? types[0] : await host.ui.select('Authentication method', types)
    if (type !== 'oauth' && type !== 'api_key') return
    const deviceId = type === 'oauth' ? await host.runtime().installationDeviceId() : undefined
    await runtime.login(provider.id, type, {
      prompt: async prompt => {
        let result: string | undefined
        if (prompt.type === 'select') {
          const option = await choose(prompt.message, [...prompt.options], item => item.label)
          result = option?.id
        } else if (prompt.type === 'secret') {
          if (!host.secretInput) throw new Error('Secure credential entry is unavailable')
          result = await host.secretInput(prompt.message, prompt.placeholder, { signal: prompt.signal })
        } else result = await host.ui.input(prompt.message, prompt.placeholder, { signal: prompt.signal })
        if (result === undefined) throw new Error('Sign-in cancelled')
        return result
      },
      notify: event => {
        if (event.type === 'auth_url') {
          notify(`${event.instructions ?? 'Open this sign-in URL:'}\n${event.url}`)
          void host.openExternal?.(event.url).catch(error => host.ui.notify(String(error), 'warning'))
        } else if (event.type === 'device_code') notify(`${event.verificationUri}\nCode: ${event.userCode}`)
        else notify(event.message)
      }
    }, deviceId ? { getDeviceId: () => deviceId } : undefined)
    notify(`Signed in to ${provider.name}`)
  }

  async function share() {
    if (!await host.ui.confirm('Share session', 'Upload the current session as a secret GitHub gist? Anyone with its link can read its contents.')) return
    const directory = await mkdtemp(join(tmpdir(), 'harness-share-'))
    try {
      const path = await host.session().exportToHtml(join(directory, 'session.html'), { themeName: host.ui.theme.name })
      const result = await promisify(execFile)('gh', ['gist', 'create', '--public=false', path], { timeout: 60_000, maxBuffer: 1024 * 1024 })
      notify(`Session shared: ${result.stdout.trim()}`)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }

  async function trajectory(runId: string) {
    const runs = await host.trajectory.list()
    if (!runs.length) { notify('No runs recorded for this native session yet'); return }
    const initialIndex = runId ? runs.findIndex(run => run.id === runId) : 0
    if (initialIndex < 0) throw new Error('Run not found in this native session')
    const initial = await host.trajectory.read(runs[initialIndex]!.id)
    await host.ui.custom<void>((tui, theme, _keys, done) => {
      const content = new TrajectoryPanel({
        tui, theme, runs, initialIndex, initial,
        read: host.trajectory.read,
        copy: host.copyText,
        close: () => done(undefined),
        changed: host.changed,
        notify: (message, type) => host.ui.notify(message, type === 'error' || type === 'warning' ? type : 'info')
      })
      const dialog = new DialogPanel('Trajectory', content, () => theme, '←/→ runs · ↑/↓ events · PgUp/PgDn details · C copy · Esc close')
      return Object.assign(dialog, { dispose: () => content.dispose() })
    }, { overlay: true, overlayOptions: { width: '100%', maxHeight: '90%' } })
  }

  async function permissions() {
    for (;;) {
      const runtime = host.runtime()
      const state = await runtime.permissions()
      const activeTools = host.session().getActiveToolNames()
      const granted = new Set(state.globalTools)
      const toolNames = [...new Set([...activeTools, ...granted])].sort((a, b) => a.localeCompare(b))
      const entries = [
        { id: 'full', label: `Full Permission: ${state.full ? 'on' : 'off'}` },
        ...toolNames.map(tool => ({ id: `tool:${tool}`, label: `${tool}: allow everywhere ${granted.has(tool) ? 'on' : 'off'}` })),
        { id: 'done', label: 'Done' }
      ]
      const description = [
        'Permissions apply to future Pi terminal approvals using this local Harness state.',
        'A tool grant allows every call with that tool name, regardless of its arguments.',
        'Full Permission approves every eligible future request. Hard denials and disabled tools still apply; human-only requests stay manual unless the host explicitly opts them in.',
        'Existing pending requests are never approved by changing these settings.'
      ].join('\n')
      const selected = await host.ui.custom<string | undefined>((tui, theme, _keys, done) => {
        const list = new SearchableSelect(entries.map(entry => entry.label), tui, () => theme,
          index => done(entries[index]?.id), () => done(undefined))
        return new DialogPanel('Permissions', list, () => theme, 'Enter change · Type to search · Esc close', description)
      }, { overlay: true, overlayOptions: { width: '100%', maxHeight: '90%' } })
      if (!selected || selected === 'done') return
      if (selected === 'full') {
        const desired = !state.full
        const latest = await runtime.permissions()
        if (latest.full !== desired) {
          if (!desired || await host.ui.confirm('Enable Full Permission?', 'Automatically approve eligible future requests in every Pi terminal session sharing this local Harness state. Hard denials and disabled tools still apply; human-only requests stay manual unless the host explicitly opts them in.')) {
            await runtime.setFullPermission(desired)
          }
        }
        continue
      }
      const tool = selected.slice('tool:'.length)
      if (!tool) continue
      const desired = !granted.has(tool)
      const latest = await runtime.permissions()
      if (latest.globalTools.includes(tool) !== desired) await runtime.setGlobalTool(tool, desired)
    }
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
          const current = host.planMode()
          const next = !argument || argument === 'toggle' ? !current : argument === 'on' ? true : argument === 'off' ? false : null
          if (next === null) throw new Error('Use /plan, /plan on, /plan off, or /plan toggle.')
          host.setPlanMode(next)
          break
        }
        case 'quit': host.shutdown(); break
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
            throw new Error('Resume sessions from this account history folder. Use /import to explicitly import a session.')
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
          const selected = await host.ui.custom<string | undefined>((tui, _theme, _keys, done) => {
            const selector = new TreeSelectorComponent(tree, session.sessionManager.getLeafId(), tui.terminal.rows,
              done, () => done(undefined), (entryId, label) => session.sessionManager.appendLabelChange(entryId, label),
              undefined, session.settingsManager.getTreeFilterMode())
            selector.onCopy = text => { if (text) void host.copyText(text).catch(error => host.ui.notify(String(error), 'error')) }
            return selector
          })
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
        case 'model': {
          const provider = session.settingsManager.getDefaultProvider()
          const id = session.settingsManager.getDefaultModel()
          const selected = await host.ui.custom<{ model: NonNullable<AgentSession['model']>; persist: boolean } | undefined>((tui, _theme, _keys, done) =>
            new ModelSelectorComponent(tui, session.model, session.modelRuntime, session.scopedModels,
              model => done({ model, persist: false }), () => done(undefined), argument || undefined,
              model => done({ model, persist: true }), provider && id ? { provider, id } : undefined))
          if (selected) await session.setModel(selected.model, { persist: selected.persist })
          break
        }
        case 'scoped-models': {
          const models = await session.modelRuntime.getAvailable()
          const selected = new Set(session.scopedModels.map(item => `${item.model.provider}/${item.model.id}`))
          for (;;) {
            const labels = models.map(model => `${selected.has(`${model.provider}/${model.id}`) ? '☑' : '☐'} ${model.provider}/${model.id}`)
            const choice = await host.ui.select('Models for cycling', [...labels, 'Save', 'Cancel'])
            if (!choice || choice === 'Cancel') break
            if (choice === 'Save') {
              session.setScopedModels(models.filter(model => selected.has(`${model.provider}/${model.id}`)).map(model => ({ model })))
              session.settingsManager.setEnabledModels([...selected])
              break
            }
            const model = models[labels.indexOf(choice)]
            if (model) { const key = `${model.provider}/${model.id}`; if (selected.has(key)) selected.delete(key); else selected.add(key) }
          }
          break
        }
        case 'settings': await settings(); break
        case 'permissions': await permissions(); break
        case 'name': {
          const name = argument || await host.ui.input('Session name', session.sessionName)
          if (name !== undefined) session.setSessionName(name)
          break
        }
        case 'session': notify(JSON.stringify(session.getSessionStats(), null, 2)); break
        case 'trajectory': await trajectory(argument); break
        case 'compact': await session.compact(argument || undefined); break
        case 'reload': await host.runtime().reload(); notify('Trusted resources reloaded'); break
        case 'trust': {
          if (!session.extensionRunner.getRegisteredCommands().some(command => command.name === 'plugins')) throw new Error('Plugin trust controls are unavailable in this session.')
          await session.prompt('/plugins')
          break
        }
        case 'bug': {
          const description = argument || await host.ui.input('Describe the Harness issue')
          if (!description) break
          const repository = manifest.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
          const url = new URL(`${repository}/issues/new`)
          url.searchParams.set('title', description.split('\n')[0]!.slice(0, 120))
          url.searchParams.set('body', `${description}\n\nHarness ${manifest.version} · ${process.platform} ${process.arch} · Node ${process.version}`)
          if (!host.openExternal) throw new Error(`Open the issue draft: ${url}`)
          if (await host.ui.confirm('Open issue draft?', `${description}\n\nOpen the Harness issue form in your browser to review and submit.`)) await host.openExternal(url.href)
          break
        }
        case 'login': await login(argument); break
        case 'logout': {
          const credentials = await session.modelRuntime.listCredentials()
          const provider = argument || await host.ui.select('Sign out of provider', credentials.map(item => item.providerId))
          if (provider && await host.ui.confirm('Sign out', `Remove the stored credential for ${provider} from this account?`)) {
            await session.modelRuntime.logout(provider)
            notify(`Signed out of ${provider}`)
          }
          break
        }
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
        case 'import': {
          const input = argument || await host.ui.input('Import session JSONL path')
          if (input) await host.runtime().importFromJsonl(resolve(host.cwd(), input))
          break
        }
        case 'share': await share(); break
        case 'hotkeys': notify(host.hotkeys?.() ?? 'Keyboard bindings are managed by the terminal application.'); break
        case 'changelog': {
          if (!host.changelog) throw new Error('No Harness release notes are installed')
          notify(await host.changelog())
          break
        }
      }
      host.refresh()
    } catch (error) { host.ui.notify(error instanceof Error ? error.message : String(error), 'error') }
    return true
  }
  return { execute, completions, skills, expandSkill }
}
