import type { Theme } from '@earendil-works/pi-coding-agent'
import { matchesKey, type Component, type Focusable, type TUI, type TuiMouseEventResult } from '@earendil-works/pi-tui'

import { CENTER_DIALOG_PAD, CHROME_PAD, centerDialogBodyRows, centerDialogContentWidth, centerDialogFrame, centerDialogVerticalPad, contentWidth, pageBodyRows, pageFrame, tabIndexAt, tabStrip } from './chrome'
import { centeredDialogHost, dialogFits, pageRows } from './dialogGeometry'
import type { TerminalMouseInput } from './mouse'
import type { TerminalPage } from './page'

export interface PageOverlayOptions {
  page: TerminalPage
  tui: TUI
  theme: () => Theme
  close(): void
  changed(): void
}

interface PointerLayout {
  tabRow?: number
  bodyStart: number
  contentX: number
  contentWidth: number
  centered: boolean
}

export class PageOverlay implements Component, Focusable {
  private focusedValue = false
  private disposed = false
  private pointerLayout?: PointerLayout
  private hoveredTab?: string

  constructor(readonly options: PageOverlayOptions) {
    options.page.activate?.()
  }

  get page(): TerminalPage { return this.options.page }
  get focused(): boolean { return this.focusedValue }
  set focused(value: boolean) {
    this.focusedValue = value
    if (this.options.page.focused !== undefined) this.options.page.focused = value
  }

  invalidate(): void {}

  handleMouse(event: TerminalMouseInput): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    if (event.type === 'wheel') {
      const layout = this.pointerLayout
      if (layout && event.y >= layout.bodyStart) {
        const handled = this.page.handleMouse?.({ ...event, x: event.x - layout.contentX, y: event.y - layout.bodyStart })
        if (handled?.handled) return handled
      }
      const key = event.wheelDelta !== undefined && event.wheelDelta < 0 ? '\x1b[5~' : '\x1b[6~'
      this.handleInput(key)
      return { handled: true, render: true }
    }
    if (event.type !== 'move' && event.type !== 'click') return undefined
    if (event.type === 'click' && event.button !== 'left') return undefined
    const layout = this.pointerLayout
    if (!layout) return undefined
    const tabs = this.options.page.tabs()
    const tabX = event.x - layout.contentX
    if (layout.tabRow !== undefined && event.y === layout.tabRow && tabs.length > 1) {
      const tabIndex = tabIndexAt(tabs, layout.contentWidth, tabX)
      const current = tabs.findIndex(tab => tab.id === this.options.page.activeTab())
      if (event.type === 'move') {
        const nextHover = tabIndex === undefined ? undefined : tabs[tabIndex]?.id
        if (nextHover === this.hoveredTab) return { handled: true, render: false }
        this.hoveredTab = nextHover
        return { handled: true, render: true }
      }
      const target = tabIndex ?? (tabX < layout.contentWidth / 2
        ? (current - 1 + tabs.length) % tabs.length
        : (current + 1) % tabs.length)
      if (this.page.selectTab) {
        this.page.selectTab(tabs[target]!.id)
        this.hoveredTab = undefined
        return { handled: true, render: true }
      }
      const delta = (target - Math.max(0, current) + tabs.length) % tabs.length
      const reverse = (Math.max(0, current) - target + tabs.length) % tabs.length
      const direction = delta <= reverse ? '\t' : '\x1b[Z'
      const steps = Math.min(delta, reverse)
      for (let index = 0; index < steps; index += 1) this.options.page.handleInput(direction)
      this.hoveredTab = undefined
      return { handled: true, render: true }
    }
    let hoverChanged = false
    if (event.type === 'move' && this.hoveredTab) {
      this.hoveredTab = undefined
      hoverChanged = true
    }
    if (event.y < layout.bodyStart) return hoverChanged ? { handled: true, render: true } : undefined
    const handled = this.options.page.handleMouse?.({ ...event, x: tabX, y: event.y - layout.bodyStart })
    return handled ?? (hoverChanged ? { handled: true, render: true } : undefined)
  }

  handleInput(data: string): void {
    if (this.disposed) return
    if (matchesKey(data, 'ctrl+c')) {
      this.options.close()
      return
    }
    const centered = this.page.presentation !== 'fullscreen' && centeredDialogHost(this.options.tui) && dialogFits(this.options.tui.terminal.columns, this.options.tui.terminal.rows)
    const tabs = this.options.page.tabs()
    const input = centered && tabs.length > 1 && !this.options.page.ownsNavigation
      ? matchesKey(data, 'right') ? '\t' : matchesKey(data, 'left') ? '\x1b[Z' : data
      : data
    if (this.options.page.handleInput(input)) {
      this.options.changed()
      return
    }
    if (matchesKey(data, 'escape')) this.options.close()
  }

  render(width: number): string[] {
    if (this.disposed) return []
    const rows = this.page.presentation === 'fullscreen' ? this.options.tui.terminal.rows : pageRows(this.options.tui)
    const page = this.options.page
    const tabs = page.tabs()
    if (width < 1 || rows < 1 || !tabs.length) return []
    const theme = this.options.theme()
    const centered = this.page.presentation !== 'fullscreen' && centeredDialogHost(this.options.tui) && dialogFits(this.options.tui.terminal.columns, this.options.tui.terminal.rows)
    const inner = centered ? centerDialogContentWidth(width) : contentWidth(width)
    if (centered) {
      const tabRows = tabs.length > 1 ? 1 : 0
      const bodyStart = centerDialogVerticalPad(rows) + 2 + tabRows
      this.pointerLayout = {
        tabRow: tabRows ? bodyStart - 1 : undefined,
        bodyStart,
        contentX: CENTER_DIALOG_PAD,
        contentWidth: inner,
        centered
      }
      const body = [
        ...(tabRows ? [tabStrip(tabs, page.activeTab(), inner, theme, 'top', this.hoveredTab)] : []),
        ...page.render(inner, Math.max(0, centerDialogBodyRows(rows) - tabRows))
      ]
      return centerDialogFrame({ title: tabs.find(tab => tab.id === page.activeTab())?.title ?? 'Page', body, width, rows, theme })
    }
    this.pointerLayout = {
      tabRow: 0,
      bodyStart: 2,
      contentX: CHROME_PAD,
      contentWidth: contentWidth(width),
      centered
    }
    const footer = page.ownsNavigation ? `Esc back/close · ${page.hint()}` : [
      page.hint(),
      tabs.length > 1 && !page.ownsNavigation ? 'Tab/Shift+Tab sections' : '',
      'Esc close'
    ].filter(Boolean).join(' · ')
    return pageFrame({
      title: '',
      headerLine: tabStrip(tabs, page.activeTab(), inner, theme, 'top', this.hoveredTab),
      body: page.render(inner, pageBodyRows(rows)),
      footer,
      width,
      rows,
      theme
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.options.page.dispose?.()
  }
}
