import type { AgentSession, ExtensionUIContext, KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, type TUI } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { createTerminalCommands, type TerminalCommandHost } from './commands'
import { PageOverlay } from './pageOverlay'
import { createHarnessTheme } from './theme'

const harnessTheme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
/** The page overlay the last command handed to `ui.custom`. */
async function overlayOf(ui: ExtensionUIContext): Promise<PageOverlay> {
  Object.assign(ui, { theme: harnessTheme })
  const [factory] = vi.mocked(ui.custom).mock.calls.at(-1)!
  return await factory({ terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI, harnessTheme, {} as KeybindingsManager, vi.fn()) as unknown as PageOverlay
}

function setup(extensionCommands = [{
  name: 'deploy', invocationName: 'deploy', description: 'Deploy the project',
  sourceInfo: { path: '/project/extensions/deploy.ts' }, handler: vi.fn(async () => {})
}]) {
  const ui = {
    notify: vi.fn(), select: vi.fn(), confirm: vi.fn(), input: vi.fn(), custom: vi.fn(async () => undefined),
    theme: { name: 'harness-titanium' }
  } as unknown as ExtensionUIContext
  let hideThinking = false
  const setHideThinkingBlock = vi.fn((hidden: boolean) => { hideThinking = hidden })
  const session = {
    extensionRunner: {
      getRegisteredCommands: () => extensionCommands,
      getCommand: (name: string) => extensionCommands.find(command => command.invocationName === name),
      createCommandContext: () => ({ commandContext: true })
    },
    resourceLoader: {
      getPrompts: () => ({ prompts: [{ name: 'review', description: 'Review code' }] }),
      getSkills: () => ({ skills: [{ name: 'diagnose', description: 'Diagnose a problem' }] })
    },
    settingsManager: {
      getEnableSkillCommands: () => true, getShowImages: () => true, getImageAutoResize: () => true, getBlockImages: () => false,
      getHideThinkingBlock: () => hideThinking, setHideThinkingBlock,
      getShowHardwareCursor: () => false, getShowTerminalProgress: () => false
    },
    autoCompactionEnabled: true, autoRetryEnabled: true, thinkingLevel: 'medium', steeringMode: 'all', followUpMode: 'one-at-a-time',
    compact: vi.fn(), reload: vi.fn(), setSessionName: vi.fn(),
    getActiveToolNames: () => ['read', 'bash'],
    getLastAssistantText: vi.fn(() => 'Actual assistant response'),
    getSessionStats: () => ({ sessionId: 'real-session', tokens: { input: 7 } }),
    exportToHtml: vi.fn(async (path: string) => path), exportToJsonl: vi.fn((path: string) => path)
  } as unknown as AgentSession
  const runtime = {
    newSession: vi.fn(), switchSession: vi.fn(), fork: vi.fn(), importFromJsonl: vi.fn(), reload: vi.fn(), navigateTree: vi.fn(),
    installationDeviceId: vi.fn(async () => '12345678-1234-4234-8234-123456789abc'),
    permissions: vi.fn(async () => ({ full: false, globalTools: [] as string[] })),
    setFullPermission: vi.fn(async () => {}), setGlobalTool: vi.fn(async () => {}),
    snapshot: vi.fn(() => ({ account: { accountId: 'a1', label: 'Work' } })),
    interrupt: vi.fn(async () => {})
  }
  const trajectoryRun = { id: 'run-1', mode: 'code', goal: 'Review the change', startedAt: '2026-10-18T00:00:00.000Z', endedAt: '2026-10-18T00:00:01.000Z', status: 'completed' }
  const host: TerminalCommandHost = {
    session: () => session, runtime: () => runtime as unknown as ReturnType<TerminalCommandHost['runtime']>, ui,
    cwd: () => '/isolated/project', sessionDirectory: () => '/isolated/account/history',
    refresh: vi.fn(), changed: vi.fn(), showHelp: vi.fn(), shutdown: vi.fn(), setEditorText: vi.fn(), copyText: vi.fn(async () => {}),
    subagents: () => [],
    plan: vi.fn(),
    btw: vi.fn(async () => {}),
    control: vi.fn(async (method: string) => ({
      'accounts.list': { accounts: [], pools: [], defaults: {} }, 'plugins.session': { projectId: null }, 'plugins.list': [],
      'hub.list': { entries: [], installed: [], origin: 'bundled' },
      'terminal.components.list': { items: [], addedIds: [], writable: false, fingerprint: null }
    })[method]) as unknown as TerminalCommandHost['control'],
    hotkeys: () => 'Escape: interrupt',
    logs: { read: vi.fn(async () => '[harness] diagnostic') },
    trajectory: {
      list: vi.fn(async () => [trajectoryRun]),
      read: vi.fn(async () => ({ run: trajectoryRun, events: [] }))
    }
  }
  return { host, session, runtime, ui, commands: createTerminalCommands(host) }
}

describe('owned terminal commands', () => {
  it('leaves ordinary prompts and supported prompt/skill commands for the SDK', async () => {
    const { commands, ui } = setup()
    for (const text of ['hello', '/review module', '/skill:diagnose trace']) {
      expect(await commands.execute(text)).toBe(false)
    }
    expect(ui.notify).not.toHaveBeenCalled()
  })

  it('namespaces Pi extension commands and dispatches their arguments to the registered handler', async () => {
    const handler = vi.fn(async () => {})
    const command = {
      name: 'deploy', invocationName: 'deploy', description: 'Deploy the project',
      sourceInfo: { path: '/project/extensions/deploy.ts' }, handler
    }
    const { commands, session, ui } = setup([command])
    expect(commands.completions().map(item => item.name)).toContain('plugin:deploy')
    expect(commands.completions().map(item => item.name)).not.toContain('deploy')

    expect(await commands.execute('/plugin:deploy staging now')).toBe(true)
    expect(handler).toHaveBeenCalledWith('staging now', { commandContext: true })
    expect(await commands.execute('/deploy staging now')).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(ui.notify).toHaveBeenLastCalledWith(expect.stringContaining('Unknown command: /deploy'), 'error')
    expect(session.extensionRunner.getCommand('deploy')).toBe(command)
  })

  it('rejects duplicate extension command names with owner diagnostics', async () => {
    const commandsForExtension = setup([
      { name: 'deploy', invocationName: 'deploy', description: 'First deploy', sourceInfo: { path: '/project/extensions/first.ts' }, handler: vi.fn(async () => {}) },
      { name: 'deploy', invocationName: 'deploy:1', description: 'Second deploy', sourceInfo: { path: '/project/extensions/second.ts' }, handler: vi.fn(async () => {}) }
    ])
    expect(commandsForExtension.commands.completions().map(item => item.name)).not.toContain('plugin:deploy')
    expect(await commandsForExtension.commands.execute('/plugin:deploy staging')).toBe(true)
    expect(commandsForExtension.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining('/project/extensions/first.ts, /project/extensions/second.ts'), 'error'
    )
  })

  it('keeps built-in plugin commands reserved and reports a colliding extension owner', async () => {
    const handler = vi.fn(async () => {})
    const { commands, ui } = setup([{
      name: 'annotate', invocationName: 'annotate', description: 'Other annotate',
      sourceInfo: { path: '/project/extensions/annotate.ts' }, handler
    }])
    expect(commands.completions().map(item => item.name)).toContain('plugin:annotate')
    expect(commands.completions().map(item => item.name)).not.toContain('plugin:annotate:1')
    await commands.execute('/plugin:annotate')
    expect(ui.custom).toHaveBeenCalledOnce()
    expect(handler).not.toHaveBeenCalled()
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining('/project/extensions/annotate.ts'), 'error')
  })

  it('rejects retired unprefixed plugin commands locally', async () => {
    const { commands, ui } = setup()
    for (const name of ['doctor', 'worktree', 'trajectory', 'subagents', 'notes', 'annotate']) {
      expect(await commands.execute(`/${name}`)).toBe(true)
    }
    expect(ui.custom).not.toHaveBeenCalled()
    expect(ui.notify).toHaveBeenLastCalledWith(expect.stringContaining('Unknown command: /annotate'), 'error')
  })

  it('consumes unknown slash commands without sending them to the model', async () => {
    const { commands, ui } = setup()
    expect(await commands.execute('/typo dangerous operation')).toBe(true)
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining('Unknown command: /typo'), 'error')
  })

  it('populates completion from builtins and loaded resources', () => {
    const { commands } = setup()
    const names = commands.completions().map(item => item.name)
    expect(names).toEqual(expect.arrayContaining(['model', 'session', 'history', 'accounts', 'review', 'effort', 'thinking', 'plugin:doctor', 'plugin:trajectory', 'plugin:subagents', 'log', 'permissions', 'components', 'plugin:notes', 'plugin:annotate', 'plugin:worktree']))
    expect(names).not.toContain('resume')
    expect(names).not.toContain('tree')
    expect(names).not.toContain('side')
    expect(commands.completions().find(item => item.name === 'btw')?.aliases).toEqual(['side'])
    expect(names).not.toContain('skill:diagnose')
    expect(new Set(names).size).toBe(names.length)
    expect(names).not.toEqual(expect.arrayContaining(['doctor', 'trajectory', 'subagents', 'notes', 'annotate', 'worktree']))
  })

  it('shows help as ordered groups, including loaded extension and prompt commands', async () => {
    const { commands, host, ui } = setup()
    await commands.execute('/help')

    const groups = vi.mocked(host.showHelp).mock.calls[0]![0]
    expect(groups.map(group => group.name)).toEqual(['Core', 'Run', 'Model', 'Session', 'Inspect', 'Harness', 'Plugins', 'Prompts'])
    expect(groups.find(group => group.name === 'Core')?.commands).toContainEqual({ name: 'help', description: 'List the commands' })
    const sessionCommands = groups.find(group => group.name === 'Session')?.commands ?? []
    expect(sessionCommands).toContainEqual({ name: 'session', aliases: ['resume'], description: 'Choose a saved session in this account and folder' })
    expect(sessionCommands).toContainEqual({ name: 'history', aliases: ['tree'], description: 'Navigate branches in the current session' })
    expect(sessionCommands.map(command => command.name)).not.toContain('resume')
    expect(sessionCommands.map(command => command.name)).not.toContain('tree')
    const runCommands = groups.find(group => group.name === 'Run')?.commands ?? []
    expect(runCommands).toContainEqual({ name: 'btw', aliases: ['side'], description: 'Ask a side question without interrupting: /btw <question>' })
    expect(runCommands.map(command => command.name)).not.toContain('side')
    expect(groups.find(group => group.name === 'Inspect')?.commands.map(command => command.name)).toEqual(['copy', 'export', 'log'])
    expect(groups.find(group => group.name === 'Plugins')?.commands.map(command => command.name)).toEqual(['plugin:subagents', 'plugin:trajectory', 'plugin:notes', 'plugin:annotate', 'plugin:doctor', 'plugin:worktree', 'plugin:deploy'])
    expect(groups.find(group => group.name === 'Prompts')?.commands).toEqual([{ name: 'review', description: 'Review code' }])
    expect(ui.notify).not.toHaveBeenCalled()
  })

  it('toggles transcript thinking visibility with /thinking and supports explicit show or hide', async () => {
    const { commands, session, ui } = setup()
    const setHideThinkingBlock = session.settingsManager.setHideThinkingBlock

    await commands.execute('/thinking')
    expect(session.settingsManager.getHideThinkingBlock()).toBe(true)
    expect(setHideThinkingBlock).toHaveBeenLastCalledWith(true)
    expect(ui.notify).toHaveBeenLastCalledWith('Thinking blocks hidden.', 'info')

    await commands.execute('/thinking show')
    expect(session.settingsManager.getHideThinkingBlock()).toBe(false)
    expect(setHideThinkingBlock).toHaveBeenLastCalledWith(false)

    await commands.execute('/thinking hide')
    expect(session.settingsManager.getHideThinkingBlock()).toBe(true)
    expect(setHideThinkingBlock).toHaveBeenLastCalledWith(true)

    await commands.execute('/thinking')
    expect(session.settingsManager.getHideThinkingBlock()).toBe(false)
    expect(setHideThinkingBlock).toHaveBeenLastCalledWith(false)

    await commands.execute('/thinking toggle')
    expect(session.settingsManager.getHideThinkingBlock()).toBe(false)
    expect(setHideThinkingBlock).toHaveBeenCalledTimes(4)
    expect(ui.notify).toHaveBeenLastCalledWith('Use /thinking, /thinking show, or /thinking hide.', 'error')
    expect(commands.completions().find(item => item.name === 'thinking')?.description).toContain('[show|hide]')
  })

  it('runs one plan request from /plan <brief> and rejects toggle syntax', async () => {
    const { commands, host, ui } = setup()
    expect(await commands.execute('/plan inspect the current implementation')).toBe(true)
    expect(host.plan).toHaveBeenCalledWith('inspect the current implementation')
    expect(await commands.execute('/plan')).toBe(true)
    expect(await commands.execute('/plan on')).toBe(true)
    expect(await commands.execute('/plan toggle')).toBe(true)
    expect(host.plan).toHaveBeenCalledOnce()
    expect(ui.notify).toHaveBeenLastCalledWith('Use /plan <plan brief>.', 'error')
    expect(commands.completions().find(item => item.name === 'plan')?.description).toContain('/plan <brief>')
  })

  it('invokes a loaded skill as $name, and leaves other text for the SDK', () => {
    const { commands, session } = setup()
    expect(commands.skills()).toEqual([{ name: 'diagnose', description: 'Diagnose a problem' }])
    expect(commands.expandSkill('$diagnose the trace')).toBe('/skill:diagnose the trace')
    expect(commands.expandSkill('$unknown the trace')).toBe('$unknown the trace')
    expect(commands.expandSkill('/skill:diagnose trace')).toBe('/skill:diagnose trace')
    vi.spyOn(session.settingsManager, 'getEnableSkillCommands').mockReturnValue(false)
    expect(commands.skills()).toEqual([])
    expect(commands.expandSkill('$diagnose the trace')).toBe('$diagnose the trace')
  })

  it('uses the scope checked runtime for both session names and an explicit path', async () => {
    const { commands, runtime } = setup()
    await commands.execute('/session /isolated/account/history/session.jsonl')
    await commands.execute('/resume /isolated/account/history/other.jsonl')
    expect(runtime.switchSession).toHaveBeenNthCalledWith(1, '/isolated/account/history/session.jsonl')
    expect(runtime.switchSession).toHaveBeenNthCalledWith(2, '/isolated/account/history/other.jsonl')
    await commands.execute('/new')
    expect(runtime.newSession).toHaveBeenCalledOnce()
  })

  it.each(['/history', '/tree'])('opens current-session branch navigation through %s', async command => {
    const { commands, session, ui } = setup()
    Object.assign(session, { sessionManager: { getTree: vi.fn(() => [{}]), getLeafId: vi.fn(() => 'leaf') } })
    Object.assign(session.settingsManager, { getTreeFilterMode: () => 'default' })

    await commands.execute(command)

    expect(session.sessionManager.getTree).toHaveBeenCalledOnce()
    expect(ui.custom).toHaveBeenCalledOnce()
  })

  it('reports rejected navigation without claiming success', async () => {
    const { commands, runtime, ui } = setup()
    runtime.switchSession.mockRejectedValue(new Error('Session is outside the prepared project scope'))
    expect(await commands.execute('/resume /isolated/account/history/session.jsonl')).toBe(true)
    expect(ui.notify).toHaveBeenCalledWith('Session is outside the prepared project scope', 'error')
  })

  it('copies actual assistant text and handles missing responses', async () => {
    const { commands, host, session, ui } = setup()
    await commands.execute('/copy')
    expect(host.copyText).toHaveBeenCalledWith('Actual assistant response')
    vi.mocked(session.getLastAssistantText).mockReturnValue(undefined)
    await commands.execute('/copy')
    expect(ui.notify).toHaveBeenCalledWith('No assistant response to copy yet', 'error')
  })

  it('keeps multiline compaction instructions and session names', async () => {
    const { commands, session } = setup()
    await commands.execute('/compact Keep the API\nand authentication details')
    expect(session.compact).toHaveBeenCalledWith('Keep the API\nand authentication details')
    await commands.execute('/name Unicode 知識 🧠')
    expect(session.setSessionName).toHaveBeenCalledWith('Unicode 知識 🧠')
  })

  it('exports supported formats through native session APIs', async () => {
    const { commands, session } = setup()
    await commands.execute('/export notes.jsonl')
    expect(session.exportToJsonl).toHaveBeenCalledWith('/isolated/project/notes.jsonl')
    await commands.execute('/export notes.html')
    expect(session.exportToHtml).toHaveBeenCalledWith('/isolated/project/notes.html', { themeName: 'harness-titanium' })
  })

  it('shows actual application keyboard bindings', async () => {
    const { commands, ui } = setup()
    await commands.execute('/hotkeys')
    expect(ui.notify).toHaveBeenCalledWith('Escape: interrupt', 'info')
  })

  it.each(['login', 'logout', 'share', 'bug', 'changelog', 'trust', 'scoped-models', 'import'])('no longer has /%s', async name => {
    const { commands, ui } = setup()
    expect(commands.completions().map(item => item.name)).not.toContain(name)
    expect(await commands.execute(`/${name} anything`)).toBe(true)
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining(`Unknown command: /${name}`), 'error')
  })

  it('asks and dismisses side questions through /btw and its /side alias', async () => {
    const { commands, host } = setup()
    expect(await commands.execute('/btw what does the plan step do?')).toBe(true)
    expect(host.btw).toHaveBeenLastCalledWith('what does the plan step do?')
    await commands.execute('/side what is the next step?')
    expect(host.btw).toHaveBeenLastCalledWith('what is the next step?')
    await commands.execute('/btw')
    expect(host.btw).toHaveBeenLastCalledWith('')
    await commands.execute('/side')
    expect(host.btw).toHaveBeenLastCalledWith('')
    expect(commands.completions().find(item => item.name === 'btw')?.description).toContain('/btw <question>')
  })

  it('stops a running reply with /stop and says when nothing is running', async () => {
    const { commands, runtime, session, ui } = setup()
    await commands.execute('/stop')
    expect(runtime.interrupt).not.toHaveBeenCalled()
    expect(ui.notify).toHaveBeenCalledWith('Nothing is running.', 'error')
    Object.assign(session, { isStreaming: true })
    await commands.execute('/stop')
    expect(runtime.interrupt).toHaveBeenCalledOnce()
  })

  it('opens Trajectory as a standalone full-screen page on the requested run', async () => {
    const { commands, host, ui } = setup()
    await commands.execute('/plugin:trajectory run-1')
    expect(ui.custom).toHaveBeenCalledOnce()
    expect(ui.custom).toHaveBeenCalledWith(expect.any(Function), { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', anchor: 'top-left', dialog: 'page' } })
    const shown = await overlayOf(ui)
    expect(shown.page.tabs().map(tab => tab.title)).toEqual(['Runs', 'Events'])
    await vi.waitFor(() => expect(host.trajectory.read).toHaveBeenCalledWith('run-1'))
    expect(shown.page.activeTab()).toBe('events')
    shown.dispose()
  })

  it('opens Log alone and reads diagnostics and current-conversation run events', async () => {
    const { commands, host, ui } = setup()
    await commands.execute('/log')
    const shown = await overlayOf(ui)
    expect(shown.page.tabs().map(tab => tab.title)).toEqual(['Diagnostics', 'Run Events'])
    await vi.waitFor(() => expect(host.logs.read).toHaveBeenCalledOnce())
    expect(host.trajectory.list).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(host.trajectory.read).toHaveBeenCalledWith('run-1'))
    shown.dispose()
  })

  it('opens Settings alone with its category tabs', async () => {
    const { commands, ui } = setup()
    await commands.execute('/settings')
    const shown = await overlayOf(ui)
    expect(shown.page.activeTab()).toBe('appearance')
    expect(shown.render(100).map(stripTerminalSequences).join('\n')).toContain('Show images')
    shown.dispose()
  })

  it.each([
    ['/accounts', ['Accounts', 'Pools']], ['/permissions', ['Overview', 'Tools']],
    ['/plugins', ['Overview', 'Foundation', 'Variant', 'Skills', 'Plugins', 'Connections', 'Tools', 'Library']], ['/hub', ['Overview', 'Foundation', 'Variant', 'Skills', 'Plugins', 'Connections', 'Tools', 'Library']],
    ['/components', ['Overview', 'Foundation', 'Variant', 'Skills', 'Plugins', 'Connections', 'Tools', 'Library']], ['/harness', ['Overview', 'Foundation', 'Variant', 'Skills', 'Plugins', 'Connections', 'Tools', 'Library']], ['/skills', ['Overview', 'Foundation', 'Variant', 'Skills', 'Plugins', 'Connections', 'Tools', 'Library']], ['/mcp', ['Overview', 'Foundation', 'Variant', 'Skills', 'Plugins', 'Connections', 'Tools', 'Library']], ['/connections', ['Overview', 'Foundation', 'Variant', 'Skills', 'Plugins', 'Connections', 'Tools', 'Library']], ['/tools', ['Overview', 'Foundation', 'Variant', 'Skills', 'Plugins', 'Connections', 'Tools', 'Library']], ['/settings', expect.any(Array)],
    ['/plugin:trajectory', ['Runs', 'Events']], ['/plugin:subagents', ['Subagents']], ['/log', ['Diagnostics', 'Run Events']]
  ])('opens %s as its own page with local tabs', async (command, tabs) => {
    const { commands, ui } = setup()
    await commands.execute(command)
    expect(ui.custom).toHaveBeenCalledOnce()
    const shown = await overlayOf(ui)
    const titles = shown.page.tabs().map(tab => tab.title)
    if (Array.isArray(tabs)) expect(titles).toEqual(tabs)
    else expect(titles.length).toBeGreaterThan(1)
    const rows = shown.render(100).map(stripTerminalSequences)
    expect(rows[0]).toContain(titles.length === 8 ? shown.page.tabs().find(tab => tab.id === shown.page.activeTab())!.title : titles[0]!)
    if (titles.length === 8) {
      expect(shown.page.presentation).toBe('fullscreen')
      expect(ui.custom).toHaveBeenCalledWith(expect.any(Function), { overlay: true, overlayOptions: { anchor: 'top-left', width: '100%', maxHeight: '100%' } })
    }
    expect(rows.join('\n')).not.toContain('  Accounts  Permissions  Plugins  Hub  Settings  Trajectory  Log')
    shown.dispose()
  })

  it('shows empty history and refuses run IDs outside the current native session on the page itself', async () => {
    const { commands, host, ui } = setup()
    vi.mocked(host.trajectory.list).mockResolvedValue([])
    await commands.execute('/plugin:trajectory')
    const empty = await overlayOf(ui)
    await vi.waitFor(() => expect(empty.render(100).map(stripTerminalSequences).join('\n')).toContain('No runs recorded for this native session yet'))
    empty.dispose()

    vi.mocked(ui.custom).mockClear()
    vi.mocked(host.trajectory.list).mockResolvedValue([{ id: 'run-1', mode: 'code', goal: null, startedAt: '2026-10-18T00:00:00.000Z', endedAt: null, status: 'running' }])
    await commands.execute('/plugin:trajectory other-run')
    const missing = await overlayOf(ui)
    await vi.waitFor(() => expect(missing.render(100).map(stripTerminalSequences).join('\n')).toContain('Run not found in this native session'))
    expect(host.trajectory.read).not.toHaveBeenCalled()
    missing.dispose()
  })

  it('exits through the application lifecycle', async () => {
    const { commands, host } = setup()
    await commands.execute('/quit')
    expect(host.shutdown).toHaveBeenCalledOnce()
  })
  it('validates thinking levels before mutating the session', async () => {
    const { commands, session, ui } = setup()
    Object.assign(session, { getAvailableThinkingLevels: () => ['off', 'high'], setThinkingLevel: vi.fn() })
    await commands.execute('/effort high')
    expect(session.setThinkingLevel).toHaveBeenCalledWith('high', { persist: true })
    await commands.execute('/effort fabricated')
    expect(session.setThinkingLevel).toHaveBeenCalledTimes(1)
    expect(ui.notify).toHaveBeenCalledWith('Available thinking levels: off, high', 'error')
  })

  it('clones the real leaf through the runtime without inventing history', async () => {
    const { commands, session, runtime, host } = setup()
    Object.assign(session, { sessionManager: { getLeafId: () => 'leaf-id' } })
    runtime.fork.mockResolvedValue({ cancelled: false })
    await commands.execute('/clone')
    expect(runtime.fork).toHaveBeenCalledWith('leaf-id', { position: 'at' })
    expect(host.setEditorText).toHaveBeenCalledWith('')
  })

  it('rejects resume paths outside account history before runtime navigation', async () => {
    const { commands, runtime, ui } = setup()
    await commands.execute('/resume /other-account/session.jsonl')
    expect(runtime.switchSession).not.toHaveBeenCalled()
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining('this account history folder'), 'error')
  })

  it('reloads through the stable runtime lifecycle', async () => {
    const { commands, runtime, session } = setup()
    await commands.execute('/reload')
    expect(runtime.reload).toHaveBeenCalledOnce()
    expect(session.reload).not.toHaveBeenCalled()
  })

})

it('offers /plugin:doctor and consumes it as a local plugin command', async () => {
  const { commands, ui } = setup()
  expect(commands.completions().some(command => command.name === 'plugin:doctor')).toBe(true)
  expect(await commands.execute('/plugin:doctor')).toBe(true)
  expect(ui.custom).toHaveBeenCalledOnce()
})
