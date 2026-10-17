import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'

const dialogs = new Set(['select', 'input', 'editor', 'custom'])

/** Retained UI methods belong to the resource generation that received them. */
export function sessionUiContext(ui: ExtensionUIContext, current: () => boolean): ExtensionUIContext {
  return new Proxy(ui, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (current()) return Reflect.apply(value, target, args)
        if (key === 'confirm') return Promise.resolve(false)
        if (dialogs.has(String(key))) return Promise.resolve(undefined)
        if (key === 'onTerminalInput') return () => {}
        if (key === 'setTheme') return { success: false, error: 'This terminal session has ended.' }
        if (key === 'getEditorText') return ''
        if (key === 'getToolsExpanded') return false
        if (key === 'getAllThemes') return []
        return undefined
      }
    }
  })
}
