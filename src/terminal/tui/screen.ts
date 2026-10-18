// Screen mode and layout. Pi's fullscreen settings still choose the mode; Harness supplies its own composition.
import { SettingsManager, copyToClipboard, type FullscreenExitOutput, type Theme, type TuiMode } from '@earendil-works/pi-coding-agent'
import { ScrollView, TuiAltScreen, TuiMainScreen, VStack, isViewportTUI, truncateToWidth, type Component, type Terminal, type TuiAltScreenOptions } from '@earendil-works/pi-tui'

export interface DockSlots {
  readonly title: Component
  readonly above: Component
  readonly queue: Component
  readonly editor: Component
  readonly below: Component
  readonly footer: Component
}

export type TerminalScreen = TuiMainScreen | TuiAltScreen

export interface ScreenPreferences {
  readonly mode: TuiMode
  readonly exitOutput: FullscreenExitOutput
  readonly scrollbar: ReturnType<SettingsManager['getFullscreenScrollbar']>
  readonly wheelScrollLines: ReturnType<SettingsManager['getFullscreenWheelScrollLines']>
  readonly copyOnSelect: boolean
}

export interface ScreenHooks {
  theme(): Theme
  latestKey(): string | undefined
  openUrl(url: string): void
  pasteClipboard(): void
}

export interface TerminalPanes {
  readonly document: Component
  readonly dock: Component
}

export function readScreenPreferences(agentDir: string | undefined): ScreenPreferences {
  // Without an account folder there is no settings file to read, so Pi's defaults apply.
  const settings = agentDir ? SettingsManager.create(process.cwd(), agentDir) : SettingsManager.inMemory()
  return {
    mode: settings.getTuiMode(),
    exitOutput: settings.getFullscreenExitOutput(),
    scrollbar: settings.getFullscreenScrollbar(),
    wheelScrollLines: settings.getFullscreenWheelScrollLines(),
    copyOnSelect: settings.getFullscreenCopyOnSelect()
  }
}

export function createTerminalScreen(terminal: Terminal, preferences: ScreenPreferences, hooks: ScreenHooks): TerminalScreen {
  if (preferences.mode === 'regular') return new TuiMainScreen(terminal)
  const { theme } = hooks
  const options: TuiAltScreenOptions = {
    wheelScrollLines: preferences.wheelScrollLines,
    copyOnSelect: preferences.copyOnSelect,
    searchMatchStyle: text => theme().underline(theme().bg('searchMatchBg', theme().fg('searchMatchText', text))),
    searchCurrentMatchStyle: text => theme().bold(theme().inverse(theme().bg('searchMatchBg', theme().fg('searchMatchText', text)))),
    searchNavigationButtonStyle: (text, hovered) => hovered ? theme().underline(text) : text,
    scrollToEndIndicator: () => {
      const key = hooks.latestKey()
      return theme().bg('selectedBg', theme().fg('text', ` ↓ Jump to latest message${key ? ` · ${keyLabel(key)}` : ''} `))
    },
    openUrl: hooks.openUrl,
    onRightClickPaste: hooks.pasteClipboard,
    copySelection: copySelectionText
  }
  return new TuiAltScreen(terminal, undefined, undefined, options)
}

/** The prompt and status keep their full height; when the screen is short, queued messages and widgets show their first rows and scroll for the rest. */
export function createDock(slots: DockSlots): VStack {
  const region = (component: Component) => new ScrollView(component)
  return new VStack([
    { component: slots.title, shrink: 0 },
    { component: region(slots.above), shrink: 1, minSize: 0 },
    { component: region(slots.queue), shrink: 1, minSize: 0 },
    { component: slots.editor, shrink: 0 },
    { component: region(slots.below), shrink: 1, minSize: 0 },
    { component: slots.footer, shrink: 0 }
  ])
}

/** Fullscreen keeps the dock on the last rows and scrolls only the transcript above it; regular mode flows in order. */
export function mountTerminalLayout(tui: TerminalScreen, panes: TerminalPanes, preferences: ScreenPreferences, hooks: ScreenHooks): ScrollView | undefined {
  if (!isViewportTUI(tui)) {
    tui.addChild(panes.document)
    tui.addChild(panes.dock)
    return undefined
  }
  const transcript = new ScrollView(panes.document, {
    follow: 'end', primary: true, overscroll: 'chain', scrollbar: preferences.scrollbar,
    scrollbarTrackStyle: text => hooks.theme().fg('scrollbarTrack', text),
    scrollbarThumbStyle: text => hooks.theme().fg('scrollbarThumb', text)
  })
  tui.setLayoutRoot(new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: panes.dock, basis: 'auto', grow: 0, shrink: 1, minSize: 1 }
  ]))
  return transcript
}

/** Rendered before the alternate screen is left, because the components are disposed afterwards. */
export function scrollbackLines(component: Component, width: number): string[] {
  return component.render(width).map(line => truncateToWidth(line, width, ''))
}

/** Leaving fullscreen discards the alternate screen, so the conversation is copied into normal scrollback. */
export function writeScrollback(terminal: Terminal, lines: string[]): void {
  terminal.write(lines.map(line => `${line}\x1b[0m`).join('\r\n') + '\r\n')
}

function keyLabel(key: string): string {
  return key.replace(/(^|\+)([a-z])/g, (_match, separator: string, letter: string) => separator + letter.toUpperCase())
}

async function copySelectionText(text: string): Promise<boolean | string> {
  try {
    await copyToClipboard(text)
    return true
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
