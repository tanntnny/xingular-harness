import type { AgentSession, ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'

import { createSettingsModel, type SettingsModelHost } from './settingsModel'

function setup(confirmed = true) {
  const browser = { allowPrivate: false }
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
    if (method === 'terminal.browser.configure') {
      browser.allowPrivate = params?.allowPrivate === true
      return { ...browser }
    }
    throw new Error(`Unexpected control call: ${method}`)
  })
  const ui = {
    theme: { name: 'Test' },
    confirm: vi.fn(async () => confirmed)
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
