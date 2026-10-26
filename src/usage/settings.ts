// Numbers a person can set on the usage plugin. They live in the one attachment store, like every
// other plugin setting (`plugins/attachments.ts`).
import type { PluginSetting } from '../plugins/types'
import { settingValue } from '../plugins/firstParty'
import * as attachments from '../plugins/attachments'

export const USAGE_SETTINGS: readonly PluginSetting[] = [
  {
    key: 'refreshMinutes',
    label: 'Limit refresh interval',
    description: 'How long a provider limit reading is kept before opening /usage:limit asks the provider again.',
    default: 10,
    min: 1,
    max: 240
  },
  {
    key: 'experimentalProbes',
    label: 'Experimental provider probes',
    description: 'Allow undocumented provider usage endpoints. Off by default; they can change without notice.',
    default: 0,
    min: 0,
    max: 1
  }
]

export interface UsageSettings {
  refreshMinutes: number
  experimentalProbes: boolean
}

export function readUsageSettings(root: string | null): UsageSettings {
  const saved = root ? attachments.load(root).settings.usage : undefined
  const values = Object.fromEntries(USAGE_SETTINGS.map((setting) => [setting.key, settingValue(setting, saved)]))
  return {
    refreshMinutes: values.refreshMinutes ?? 10,
    experimentalProbes: (values.experimentalProbes ?? 0) === 1
  }
}
