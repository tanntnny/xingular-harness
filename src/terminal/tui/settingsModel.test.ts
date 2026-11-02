import type { AgentSession, ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'

import { createSettingsModel, type SettingsModelHost } from './settingsModel'

function setup(confirmed = true) {
  const browser = { backend: 'isolated' as 'isolated' | 'brave', allowPrivate: false }
  const extension = { state: 'stopped' as 'stopped' | 'pairing' | 'waiting' | 'connected' | 'paused', paired: false, connected: false, paused: false }
  const session = {
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    thinkingLevel: 'medium',
    steeringMode: 'all',
    followUpMode: 'all',
    settingsManager: {
      getShowImages: () => true,
      getImageAutoResize: () => true,
      getBlockImages: () => false,
      getEnableSkillCommands: () => true,
      getHideThinkingBlock: () => false,
      getShowHardwareCursor: () => false,
      getShowTerminalProgress: () => true
    }
  } as unknown as AgentSession
  const control = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'terminal.browser.config') return { ...browser }
    if (method === 'terminal.browser.extension.status') return { ...extension }
    if (method === 'terminal.browser.extension.start') {
      Object.assign(extension, { state: 'pairing', paired: false, connected: false, paused: false })
      return { status: { ...extension }, pairingCode: '38671:ABCDEF012345' }
    }
    if (method === 'terminal.browser.extension.stop') {
      Object.assign(extension, { state: 'stopped', paired: false, connected: false, paused: false })
      return { ...extension }
    }
    if (method === 'terminal.browser.configure') {
      if (params?.backend === 'isolated' || params?.backend === 'brave') browser.backend = params.backend
      if (typeof params?.allowPrivate === 'boolean') browser.allowPrivate = params.allowPrivate
      return { ...browser }
    }
    throw new Error(`Unexpected control call: ${method}`)
  })
  const ui = {
    theme: { name: 'Test' },
    confirm: vi.fn(async () => confirmed),
    select: vi.fn(async () => 'Brave profile'),
    notify: vi.fn()
  } as unknown as ExtensionUIContext
  const refresh = vi.fn()
  const model = createSettingsModel({
    session: () => session,
    ui,
    refresh,
    control: control as unknown as SettingsModelHost['control']
  })
  return { model, browser, control, refresh, ui }
}

describe('terminal settings model', () => {
  it('loads the device-local browser setting on demand', async () => {
    const { model, control } = setup()
    expect(model.items().some(item => item.id === 'browser.allowPrivate')).toBe(false)

    await model.load()

    expect(control).toHaveBeenCalledWith('terminal.browser.config')
    expect(model.items()).toContainEqual(expect.objectContaining({
      id: 'browser.allowPrivate', tab: 'Browser', label: 'Private address access', value: 'Off'
    }))
    expect(model.items()).toContainEqual(expect.objectContaining({ id: 'browser.backend', value: 'Isolated browser' }))
    expect(model.items()).toContainEqual(expect.objectContaining({ id: 'browser.connection', value: 'stopped' }))
  })

  it('requires confirmation before selecting the signed-in Brave profile', async () => {
    const { model, browser, control, ui } = setup()
    await model.load()

    await model.apply('browser.backend')

    expect(ui.confirm).toHaveBeenCalledWith('Use your Brave profile?', expect.stringContaining('signed-in pages'))
    expect(control).toHaveBeenCalledWith('terminal.browser.configure', { backend: 'brave' })
    expect(browser.backend).toBe('brave')
    expect(model.items()).toContainEqual(expect.objectContaining({ id: 'browser.backend', value: 'Brave profile' }))
  })

  it('starts the bridge and displays its one-time pairing code', async () => {
    const { model, control, ui } = setup()
    await model.load()

    await model.apply('browser.connection')

    expect(control).toHaveBeenCalledWith('terminal.browser.extension.start')
    expect(ui.notify).toHaveBeenCalledWith('Pair the Brave extension with code 38671:ABCDEF012345.', 'info')
    expect(model.items()).toContainEqual(expect.objectContaining({ id: 'browser.connection', value: 'pairing', description: expect.stringContaining('38671:ABCDEF012345') }))
  })

  it('confirms before enabling and disables without another confirmation', async () => {
    const { model, browser, control, refresh, ui } = setup()
    await model.load()

    await model.apply('browser.allowPrivate')
    expect(ui.confirm).toHaveBeenCalledWith('Allow private network addresses?', expect.stringContaining('agent browsing'))
    expect(control).toHaveBeenCalledWith('terminal.browser.configure', { allowPrivate: true })
    expect(browser.allowPrivate).toBe(true)
    expect(model.items()).toContainEqual(expect.objectContaining({ id: 'browser.allowPrivate', value: 'On' }))

    await model.apply('browser.allowPrivate')
    expect(ui.confirm).toHaveBeenCalledTimes(1)
    expect(control).toHaveBeenLastCalledWith('terminal.browser.configure', { allowPrivate: false })
    expect(browser.allowPrivate).toBe(false)
    expect(model.items()).toContainEqual(expect.objectContaining({ id: 'browser.allowPrivate', value: 'Off' }))
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('leaves private access disabled when the person declines', async () => {
    const { model, browser, control, ui } = setup(false)
    await model.load()

    await model.apply('browser.allowPrivate')

    expect(ui.confirm).toHaveBeenCalledTimes(1)
    expect(control).not.toHaveBeenCalledWith('terminal.browser.configure', expect.anything())
    expect(browser.allowPrivate).toBe(false)
    expect(model.items()).toContainEqual(expect.objectContaining({ id: 'browser.allowPrivate', value: 'Off' }))
  })
})
