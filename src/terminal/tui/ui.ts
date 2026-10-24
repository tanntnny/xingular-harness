import { Theme, type AutocompleteProviderFactory, type ExtensionUIContext, type KeybindingsManager, type WorkingIndicatorOptions } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, type AutocompleteProvider, type EditorComponent, type TUI } from '@earendil-works/pi-tui'

import { TerminalDialogs, type GroupedSelectOption } from './dialogs'

type EditorFactory = Parameters<ExtensionUIContext['setEditorComponent']>[0]
type HeaderFactory = Parameters<ExtensionUIContext['setHeader']>[0]
type FooterFactory = Parameters<ExtensionUIContext['setFooter']>[0]
type WidgetContent = string[] | ((...args: Parameters<NonNullable<HeaderFactory>>) => ReturnType<NonNullable<HeaderFactory>>) | undefined

export interface TerminalUiState {
  theme: Theme
  workingMessage?: string
  workingVisible: boolean
  workingIndicator?: WorkingIndicatorOptions
  hiddenThinkingLabel?: string
  toolsExpanded: boolean
  autocompleteFactories: AutocompleteProviderFactory[]
}
export interface TerminalUiOptions {
  tui: TUI
  theme: Theme
  keybindings: KeybindingsManager
  changed(): void
  notify(message: string, type?: string): void
  setEditor(factory: EditorFactory): void
  getEditorText(): string
  setEditorText(value: string): void
  setStatus(key: string, value: string | undefined): void
  setWidget(key: string, content: WidgetContent, placement?: string): void
  setHeader(factory: HeaderFactory): void
  setFooter(factory: FooterFactory): void
  getEditor?(): EditorComponent
  getAutocompleteProvider?(): AutocompleteProvider
  setAutocompleteProvider?(provider: AutocompleteProvider): void
  themes?: Theme[]
  themeChanged?(theme: Theme): void
  getToolsExpanded?(): boolean
  setToolsExpanded?(expanded: boolean): void
}
export interface TerminalUi extends ExtensionUIContext {
  readonly state: TerminalUiState
  secretInput: ExtensionUIContext['input']
  selectGrouped(title: string, options: readonly GroupedSelectOption[], opts?: Parameters<ExtensionUIContext['select']>[2]): Promise<string | undefined>
  wrapAutocomplete(provider: AutocompleteProvider): AutocompleteProvider
  reset(): void
  setThemes(themes: Theme[]): void
  dispose(): void
}

/** UI adaptation only: the Application owns component mounting and terminal lifecycle. */
export function createTerminalUi(options: TerminalUiOptions): TerminalUi {
  const state: TerminalUiState = {
    theme: options.theme, workingVisible: true, toolsExpanded: false, autocompleteFactories: []
  }
  const dialogs = new TerminalDialogs(options.tui, () => state.theme, options.keybindings, options.changed)
  const inputSubscriptions = new Set<() => void>()
  const builtInThemes = options.themes ?? []
  const themes = new Map(builtInThemes.filter(theme => theme.name).map(theme => [theme.name!, theme]))
  if (options.theme.name) themes.set(options.theme.name, options.theme)
  const statusKeys = new Set<string>()
  const widgetKeys = new Set<string>()
  let editorFactory: EditorFactory
  let disposed = false
  const changed = () => { if (!disposed) options.changed() }
  const wrapAutocomplete = (provider: AutocompleteProvider) => state.autocompleteFactories.reduce((current, factory) => factory(current), provider)
  return {
    state,
    select: (title, items, opts) => dialogs.select(title, items, opts),
    selectGrouped: (title, items, opts) => dialogs.selectGrouped(title, items, opts),
    confirm: (title, message, opts) => dialogs.confirm(title, message, opts),
    input: (title, placeholder, opts) => dialogs.input(title, placeholder, opts),
    secretInput: (title, placeholder, opts) => dialogs.input(title, placeholder, opts, true),
    editor: (title, prefill) => dialogs.editor(title, prefill),
    custom: (factory, opts) => dialogs.custom(factory, opts),
    notify: (message, type) => options.notify(message, type),
    onTerminalInput(handler) {
      if (disposed) return () => {}
      const remove = options.tui.addInputListener(handler)
      const unsubscribe = () => { if (inputSubscriptions.delete(unsubscribe)) remove() }
      inputSubscriptions.add(unsubscribe)
      return unsubscribe
    },
    setStatus(key, value) { if (value === undefined) statusKeys.delete(key); else statusKeys.add(key); options.setStatus(key, value); changed() },
    setWorkingMessage(message) { state.workingMessage = message; changed() },
    setWorkingVisible(visible) { state.workingVisible = visible; changed() },
    setWorkingIndicator(indicator) {
      state.workingIndicator = indicator ? { ...indicator, frames: indicator.frames?.slice() } : undefined
      changed()
    },
    setHiddenThinkingLabel(label) { state.hiddenThinkingLabel = label; changed() },
    setWidget(key, content, placement) { if (content === undefined) widgetKeys.delete(key); else widgetKeys.add(key); options.setWidget(key, content, placement?.placement); changed() },
    setHeader(factory) { options.setHeader(factory); changed() },
    setFooter(factory) { options.setFooter(factory); changed() },
    setTitle(title) { options.tui.terminal.setTitle(stripTerminalSequences(title).replace(/[\x00-\x1f\x7f]/g, ' ')) },
    pasteToEditor(text) {
      const editor = options.getEditor?.()
      if (editor) editor.handleInput(`\x1b[200~${text}\x1b[201~`)
      else options.setEditorText(options.getEditorText() + text)
      changed()
    },
    setEditorText(text) { options.setEditorText(text); changed() },
    getEditorText: options.getEditorText,
    addAutocompleteProvider(factory) {
      state.autocompleteFactories.push(factory)
      const base = options.getAutocompleteProvider?.()
      if (base) options.setAutocompleteProvider?.(wrapAutocomplete(base))
      changed()
    },
    wrapAutocomplete,
    setEditorComponent(factory) { editorFactory = factory; options.setEditor(factory); changed() },
    getEditorComponent: () => editorFactory,
    get theme() { return state.theme },
    getAllThemes: () => [...themes].map(([name, theme]) => ({ name, path: theme.sourcePath })),
    getTheme: name => themes.get(name),
    setTheme(themeOrName) {
      const theme = typeof themeOrName === 'string' ? themes.get(themeOrName) : themeOrName
      if (!(theme instanceof Theme)) return { success: false, error: `Unknown theme: ${String(themeOrName)}` }
      state.theme = theme
      if (theme.name) themes.set(theme.name, theme)
      options.themeChanged?.(theme)
      options.tui.invalidate()
      changed()
      return { success: true }
    },
    getToolsExpanded: () => options.getToolsExpanded?.() ?? state.toolsExpanded,
    setToolsExpanded(expanded) { state.toolsExpanded = expanded; options.setToolsExpanded?.(expanded); changed() },
    setThemes(loaded) {
      themes.clear()
      for (const theme of builtInThemes) if (theme.name) themes.set(theme.name, theme)
      for (const theme of loaded) if (theme.name) themes.set(theme.name, theme)
      if (options.theme.name && !themes.has(options.theme.name)) themes.set(options.theme.name, options.theme)
      if (state.theme.name && !themes.has(state.theme.name)) themes.set(state.theme.name, state.theme)
      changed()
    },
    reset() {
      if (disposed) return
      dialogs.reset()
      for (const unsubscribe of [...inputSubscriptions]) unsubscribe()
      inputSubscriptions.clear()
      for (const key of statusKeys) options.setStatus(key, undefined)
      for (const key of widgetKeys) options.setWidget(key, undefined)
      statusKeys.clear()
      widgetKeys.clear()
      state.autocompleteFactories = []
      state.workingMessage = undefined
      state.workingVisible = true
      state.workingIndicator = undefined
      state.hiddenThinkingLabel = undefined
      state.toolsExpanded = false
      editorFactory = undefined
      options.setHeader(undefined)
      options.setFooter(undefined)
      options.setEditor(undefined)
      options.setToolsExpanded?.(false)
      const base = options.getAutocompleteProvider?.()
      if (base) options.setAutocompleteProvider?.(base)
      changed()
    },
    dispose() {
      if (disposed) return
      disposed = true
      dialogs.dispose()
      for (const unsubscribe of [...inputSubscriptions]) unsubscribe()
      inputSubscriptions.clear()
    }
  }
}
