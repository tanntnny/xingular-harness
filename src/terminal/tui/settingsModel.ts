// What the Settings page lists and how a choice is applied. Values and actions belong to the Pi session.
import type { AgentSession, ExtensionUIContext } from '@earendil-works/pi-coding-agent'

import type { TerminalSettingItem } from './pages/settingsPage'

export interface SettingsModelHost {
  session(): AgentSession
  ui: ExtensionUIContext
  control<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  hotkeys?(): string
  refresh(): void
}

interface BrowserSettings {
  allowPrivate: boolean
}

const PRIVATE_ACCESS_ID = 'browser.allowPrivate'
const GROUP_ORDER = ['Theme', 'Display', 'Images', 'Thinking', 'Recovery', 'Editor', 'Queues', 'Commands', 'Terminal', 'Keyboard', 'Compaction', 'Network']

export function createSettingsModel(host: SettingsModelHost) {
  let browserSettings: BrowserSettings | null = null

  const booleans = (session: AgentSession) => {
    const settings = session.settingsManager
    return [
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
  }
  const locations = [
    ['Context', 'Compaction'], ['Model', 'Recovery'], ['Appearance', 'Images'], ['Appearance', 'Images'],
    ['Context', 'Images'], ['Interaction', 'Commands'], ['Appearance', 'Display'], ['Interaction', 'Editor'],
    ['Interaction', 'Terminal'], ['Model', 'Thinking'], ['Interaction', 'Queues'], ['Interaction', 'Queues'],
    ['Appearance', 'Theme'], ['Interaction', 'Keyboard']
  ] as const
  const descriptions = [
    'Compact the context automatically when the session approaches its limit.', 'Retry eligible provider failures automatically.',
    'Display actual image content returned by tools.', 'Resize image attachments before provider requests.',
    'Block image attachments in provider requests.', 'Expose commands for the skills loaded in this session.',
    'Collapse assistant thinking blocks in the transcript.', 'Display the terminal hardware cursor for editing and input methods.',
    'Report active work through supported terminal progress controls.', 'Reasoning effort for the current model.',
    'Delivery mode for messages that steer an active run.', 'Delivery mode for messages queued after a run.',
    'Theme loaded from the trusted resource catalog.', 'View the current application keyboard bindings.'
  ]
  /** One line per setting, `Label: value`; its position is the setting's id. */
  const options = (session: AgentSession): string[] => [
    ...booleans(session).map(([label, get]) => `${label}: ${get() ? 'on' : 'off'}`),
    `Thinking: ${session.thinkingLevel}`, `Steering: ${session.steeringMode}`, `Follow-up: ${session.followUpMode}`,
    `Theme: ${host.ui.theme.name}`, 'Keyboard controls'
  ]

  function items(): TerminalSettingItem[] {
    const result: TerminalSettingItem[] = options(host.session()).map((option, index) => {
      const split = option.indexOf(':')
      return { id: String(index), tab: locations[index]![0], group: locations[index]![1], label: split < 0 ? option : option.slice(0, split), value: split < 0 ? '' : option.slice(split + 1).trim(), description: descriptions[index] }
    })
    if (browserSettings) result.push({
      id: PRIVATE_ACCESS_ID,
      tab: 'Browser',
      group: 'Network',
      label: 'Private address access',
      value: browserSettings.allowPrivate ? 'On' : 'Off',
      description: 'This device-wide setting affects agent browsing and annotation capture. When on, pages can reach localhost and private networks.'
    })
    return result.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
  }

  async function load(): Promise<void> {
    const config = await host.control<BrowserSettings>('terminal.browser.config')
    if (!config || typeof config.allowPrivate !== 'boolean') throw new Error('The Harness returned invalid browser settings.')
    browserSettings = { allowPrivate: config.allowPrivate }
  }

  async function apply(id: string): Promise<void> {
    if (id === PRIVATE_ACCESS_ID) {
      if (!browserSettings) return
      const allowPrivate = !browserSettings.allowPrivate
      if (allowPrivate && !await host.ui.confirm(
        'Allow private network addresses?',
        'This device-wide setting lets pages opened by agent browsing and annotation capture reach localhost and private networks.'
      )) return
      const saved = await host.control<BrowserSettings>('terminal.browser.configure', { allowPrivate })
      if (!saved || typeof saved.allowPrivate !== 'boolean') throw new Error('The Harness returned invalid browser settings.')
      browserSettings = { allowPrivate: saved.allowPrivate }
      host.refresh()
      return
    }

    const session = host.session()
    const index = Number(id)
    const switches = booleans(session)
    const selected = options(session)[index]
    if (selected === undefined) return
    if (index < switches.length) {
      const [, get, set] = switches[index]!
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
        session.settingsManager.setTheme(theme)
      }
    } else host.ui.notify(host.hotkeys?.() ?? 'Use /help for commands. Keyboard bindings are managed by the terminal application.', 'info')
    host.refresh()
  }

  return { items, apply, load }
}
