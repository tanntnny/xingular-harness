import type { KeybindingsManager as PiKeybindingsManager } from '@earendil-works/pi-coding-agent'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KeybindingsManager, TUI_KEYBINDINGS, type KeybindingDefinitions, type KeybindingsConfig } from '@earendil-works/pi-tui'

// Harness owns application actions. Editing and selection retain Pi's reusable bindings.
const actions: Record<string, string | string[]> = {
  'app.interrupt': 'escape', 'app.clear': 'ctrl+c', 'app.exit': 'ctrl+d',
  'app.suspend': process.platform === 'win32' ? [] : 'ctrl+z',
  'app.thinking.cycle': 'shift+tab', 'app.thinking.save': 'ctrl+s',
  'app.model.cycleForward': 'ctrl+p', 'app.model.cycleBackward': 'alt+p',
  'app.model.select': 'ctrl+l', 'app.tools.expand': 'ctrl+o', 'app.thinking.toggle': 'ctrl+t',
  'app.editor.external': 'ctrl+g', 'app.message.copy': 'ctrl+x',
  'app.message.followUp': 'alt+enter', 'app.message.dequeue': 'alt+up',
  'app.clipboard.pasteImage': process.platform === 'darwin' ? 'alt+v' : 'ctrl+v',
  'app.session.toggleNamedFilter': 'ctrl+n', 'app.session.togglePath': 'ctrl+p',
  'app.session.toggleSort': 'ctrl+s', 'app.session.rename': 'ctrl+r',
  'app.session.delete': 'ctrl+d', 'app.session.deleteNoninvasive': 'ctrl+backspace',
  'app.tree.foldOrUp': ['alt+left', 'ctrl+left'], 'app.tree.unfoldOrDown': ['alt+right', 'ctrl+right'],
  'app.tree.editLabel': 'shift+l', 'app.tree.toggleLabelTimestamp': 'shift+t',
  'app.tree.filter.default': 'ctrl+d', 'app.tree.filter.noTools': 'ctrl+t',
  'app.tree.filter.userOnly': 'ctrl+u', 'app.tree.filter.labeledOnly': 'ctrl+l',
  'app.tree.filter.all': 'ctrl+a', 'app.tree.filter.cycleForward': 'ctrl+o',
  'app.tree.filter.cycleBackward': 'ctrl+shift+o', 'app.models.save': 'ctrl+s',
  'app.models.enableAll': 'ctrl+a', 'app.models.clearAll': 'ctrl+x',
  'app.models.toggleProvider': 'ctrl+p', 'app.models.reorderUp': 'alt+up', 'app.models.reorderDown': 'alt+down',
  'app.session.new': [], 'app.session.tree': [], 'app.session.fork': [], 'app.session.resume': []
}
export const HARNESS_KEYBINDINGS: KeybindingDefinitions = {
  ...TUI_KEYBINDINGS,
  ...Object.fromEntries(Object.entries(actions).map(([name, keys]) => [name, { defaultKeys: keys, description: name.replace(/^app\./, '').replaceAll('.', ' ') }])) as KeybindingDefinitions
}

function readBindings(agentDir: string): KeybindingsConfig {
  let bindings: KeybindingsConfig = {}
  try {
    const source = JSON.parse(readFileSync(join(agentDir, 'keybindings.json'), 'utf8'))
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      bindings = Object.fromEntries(Object.entries(source).filter(([, value]) => typeof value === 'string' || Array.isArray(value) && value.every(key => typeof key === 'string'))) as KeybindingsConfig
    }
  } catch { /* A missing keybindings file uses the application defaults. */ }
  return bindings
}

export function terminalKeybindings(agentDir: string): PiKeybindingsManager {
  const manager = new KeybindingsManager(HARNESS_KEYBINDINGS, readBindings(agentDir))
  // CustomEditor and selector factories type their manager as Pi's private subclass.
  // They consume the public base plus getEffectiveConfig; Harness owns the definitions.
  return Object.assign(manager, { getEffectiveConfig: () => manager.getResolvedBindings(), reload() { manager.setUserBindings(readBindings(agentDir)) } }) as unknown as PiKeybindingsManager
}
