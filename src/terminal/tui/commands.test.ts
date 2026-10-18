import type { AgentSession, ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import { createTerminalCommands, type TerminalCommandHost } from './commands'

function setup() {
  const ui = {
    notify: vi.fn(), select: vi.fn(), confirm: vi.fn(), input: vi.fn(), custom: vi.fn(async () => undefined),
    theme: { name: 'harness-titanium' }
  } as unknown as ExtensionUIContext
  const session = {
    extensionRunner: { getRegisteredCommands: () => [{ name: 'accounts', description: 'Manage accounts' }] },
    resourceLoader: {
      getPrompts: () => ({ prompts: [{ name: 'review', description: 'Review code' }] }),
      getSkills: () => ({ skills: [{ name: 'diagnose', description: 'Diagnose a problem' }] })
    },
    settingsManager: { getEnableSkillCommands: () => true },
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
    setFullPermission: vi.fn(async () => {}), setGlobalTool: vi.fn(async () => {})
  }
  const trajectoryRun = { id: 'run-1', mode: 'code', goal: 'Review the change', startedAt: '2026-10-18T00:00:00.000Z', endedAt: '2026-10-18T00:00:01.000Z', status: 'completed' }
  const host: TerminalCommandHost = {
    session: () => session, runtime: () => runtime as unknown as ReturnType<TerminalCommandHost['runtime']>, ui,
    cwd: () => '/isolated/project', sessionDirectory: () => '/isolated/account/history',
    refresh: vi.fn(), changed: vi.fn(), shutdown: vi.fn(), setEditorText: vi.fn(), copyText: vi.fn(async () => {}),
    hotkeys: () => 'Escape: interrupt', changelog: async () => 'Harness release notes',
    trajectory: {
      list: vi.fn(async () => [trajectoryRun]),
      read: vi.fn(async () => ({ run: trajectoryRun, events: [] }))
    }
  }
  return { host, session, runtime, ui, commands: createTerminalCommands(host) }
}

describe('owned terminal commands', () => {
  it('leaves ordinary prompts and supported extension/resource commands for the SDK', async () => {
    const { commands, ui } = setup()
    for (const text of ['hello', '/accounts', '/review module', '/skill:diagnose trace']) {
      expect(await commands.execute(text)).toBe(false)
    }
    expect(ui.notify).not.toHaveBeenCalled()
  })

  it('consumes unknown slash commands without sending them to the model', async () => {
    const { commands, ui } = setup()
    expect(await commands.execute('/typo dangerous operation')).toBe(true)
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining('Unknown command: /typo'), 'error')
  })

  it('populates completion from builtins and loaded resources', () => {
    const { commands } = setup()
    const names = commands.completions().map(item => item.name)
    expect(names).toEqual(expect.arrayContaining(['model', 'resume', 'accounts', 'review', 'effort', 'trajectory', 'permissions']))
    expect(names).not.toContain('thinking')
    expect(names).not.toContain('skill:diagnose')
    expect(new Set(names).size).toBe(names.length)
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

  it('uses the scope checked runtime for explicit resume and import paths', async () => {
    const { commands, runtime } = setup()
    await commands.execute('/resume /isolated/account/history/session.jsonl')
    expect(runtime.switchSession).toHaveBeenCalledWith('/isolated/account/history/session.jsonl')
    await commands.execute('/import other.jsonl')
    expect(runtime.importFromJsonl).toHaveBeenCalledWith('/isolated/project/other.jsonl')
    await commands.execute('/new')
    expect(runtime.newSession).toHaveBeenCalledOnce()
  })

  it('passes the Harness installation device ID to direct OAuth sign-in', async () => {
    const { commands, session, runtime } = setup()
    const login = vi.fn(async (_provider: string, _type: string, _interaction: unknown, options?: { getDeviceId?: () => string }) => options)
    Object.assign(session, { modelRuntime: {
      getProviders: () => [{ id: 'openai', name: 'OpenAI', auth: { oauth: {}, apiKey: undefined } }],
      login
    } })

    await commands.execute('/login openai')

    expect(runtime.installationDeviceId).toHaveBeenCalledOnce()
    expect(login.mock.calls[0]?.[3]?.getDeviceId?.()).toBe('12345678-1234-4234-8234-123456789abc')
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

  it('does not upload anything after a declined share confirmation', async () => {
    const { commands, ui, session } = setup()
    vi.mocked(ui.confirm).mockResolvedValue(false)
    await commands.execute('/share')
    expect(ui.confirm).toHaveBeenCalledOnce()
    expect(session.exportToHtml).not.toHaveBeenCalled()
  })

  it('shows actual application keyboard bindings and release notes', async () => {
    const { commands, ui } = setup()
    await commands.execute('/hotkeys')
    expect(ui.notify).toHaveBeenCalledWith('Escape: interrupt', 'info')
    await commands.execute('/changelog')
    expect(ui.notify).toHaveBeenCalledWith('Harness release notes', 'info')
  })

  it('opens the latest or requested trajectory run in the interactive overlay', async () => {
    const { commands, host, ui } = setup()
    await commands.execute('/trajectory')
    expect(host.trajectory.list).toHaveBeenCalledOnce()
    expect(host.trajectory.read).toHaveBeenCalledWith('run-1')
    expect(ui.custom).toHaveBeenCalledOnce()
    expect(ui.custom).toHaveBeenCalledWith(expect.any(Function), { overlay: true, overlayOptions: { width: '100%', maxHeight: '90%' } })

    await commands.execute('/trajectory run-1')
    expect(host.trajectory.read).toHaveBeenLastCalledWith('run-1')
  })

  it('shows shared tool grants and confirms Full Permission before enabling it', async () => {
    const { commands, host, runtime, ui } = setup()
    vi.mocked(ui.custom).mockImplementationOnce(async () => 'tool:bash' as never)
      .mockImplementationOnce(async () => 'done' as never)
    await commands.execute('/permissions')
    expect(runtime.permissions).toHaveBeenCalled()
    expect(runtime.setGlobalTool).toHaveBeenCalledWith('bash', true)

    vi.mocked(ui.custom).mockImplementationOnce(async () => 'full' as never)
      .mockImplementationOnce(async () => 'done' as never)
    vi.mocked(ui.confirm).mockResolvedValueOnce(true)
    await commands.execute('/permissions')
    expect(ui.confirm).toHaveBeenCalledWith('Enable Full Permission?', expect.stringContaining('Hard denials'))
    expect(runtime.setFullPermission).toHaveBeenCalledWith(true)
    expect(host.refresh).toHaveBeenCalled()
  })

  it('reports empty history and refuses run IDs outside the current native session', async () => {
    const { commands, host, ui } = setup()
    vi.mocked(host.trajectory.list).mockResolvedValue([])
    await commands.execute('/trajectory')
    expect(ui.notify).toHaveBeenCalledWith('No runs recorded for this native session yet', 'info')
    expect(ui.custom).not.toHaveBeenCalled()

    vi.mocked(host.trajectory.list).mockResolvedValue([{ id: 'run-1', mode: 'code', goal: null, startedAt: '2026-10-18T00:00:00.000Z', endedAt: null, status: 'running' }])
    await commands.execute('/trajectory other-run')
    expect(host.trajectory.read).not.toHaveBeenCalled()
    expect(ui.notify).toHaveBeenLastCalledWith('Run not found in this native session', 'error')
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

  it('uses masked input for secret provider credentials', async () => {
    const { commands, session, host, ui } = setup()
    const login = vi.fn(async (_provider, _type, interaction) => {
      expect(await interaction.prompt({ type: 'secret', message: 'API key' })).toBe('private-key')
    })
    Object.assign(session, { modelRuntime: {
      getProviders: () => [{ id: 'provider', name: 'Provider', auth: { apiKey: { login: true } } }], login
    } })
    host.secretInput = vi.fn(async () => 'private-key')
    await commands.execute('/login provider')
    expect(host.secretInput).toHaveBeenCalledWith('API key', undefined, { signal: undefined })
    expect(ui.input).not.toHaveBeenCalled()
    expect(ui.notify).not.toHaveBeenCalledWith(expect.stringContaining('private-key'), expect.anything())
  })

  it('fails closed when secure credential input is unavailable', async () => {
    const { commands, session, ui } = setup()
    Object.assign(session, { modelRuntime: {
      getProviders: () => [{ id: 'provider', name: 'Provider', auth: { apiKey: { login: true } } }],
      login: async (_provider: string, _type: string, interaction: { prompt(prompt: unknown): Promise<string> }) => interaction.prompt({ type: 'secret', message: 'API key' })
    } })
    await commands.execute('/login provider')
    expect(ui.input).not.toHaveBeenCalled()
    expect(ui.notify).toHaveBeenCalledWith('Secure credential entry is unavailable', 'error')
  })

  it('rejects resume paths outside account history before runtime navigation', async () => {
    const { commands, runtime, ui } = setup()
    await commands.execute('/resume /other-account/session.jsonl')
    expect(runtime.switchSession).not.toHaveBeenCalled()
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining('this account history folder'), 'error')
  })

  it('routes trust through the existing protected plugin workflow', async () => {
    const { commands, session } = setup()
    Object.assign(session, { prompt: vi.fn(async () => {}) })
    vi.spyOn(session.extensionRunner, 'getRegisteredCommands').mockReturnValue([{ name: 'plugins' }] as never)
    await commands.execute('/trust')
    expect(session.prompt).toHaveBeenCalledWith('/plugins')
  })

  it('opens a reviewable Harness issue draft without attaching session history', async () => {
    const { commands, host, ui } = setup()
    host.openExternal = vi.fn(async () => {})
    vi.mocked(ui.confirm).mockResolvedValue(false)
    await commands.execute('/bug Unicode issue 知識')
    expect(host.openExternal).not.toHaveBeenCalled()
    vi.mocked(ui.confirm).mockResolvedValue(true)
    await commands.execute('/bug Unicode issue 知識')
    const url = new URL(vi.mocked(host.openExternal).mock.calls[0][0])
    expect(url.pathname).toBe('/tanntnny/xingular-harness/issues/new')
    expect(url.searchParams.get('title')).toBe('Unicode issue 知識')
    expect(url.searchParams.get('body')).toContain('Harness')
  })

  it('reloads through the stable runtime lifecycle', async () => {
    const { commands, runtime, session } = setup()
    await commands.execute('/reload')
    expect(runtime.reload).toHaveBeenCalledOnce()
    expect(session.reload).not.toHaveBeenCalled()
  })

})
