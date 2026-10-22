import type { Theme } from '@earendil-works/pi-coding-agent'
import { SelectList, stripTerminalSequences, truncateToWidth, visibleWidth, type Component, type Focusable, type SelectListTheme, type TUI } from '@earendil-works/pi-tui'

import type { QuestionOption } from '../../sessions/contracts'
import { selectedRow, selectionText } from './chrome'
import { centeredDialogHost, dialogFits } from './dialogGeometry'
import { DialogPanel } from './dialogs'

const RECOMMENDED = '(Recommended)'

type DisplayOption = { option: QuestionOption; index: number }

export type QuestionPickerResult =
  | { type: 'answer'; selected: string[] }
  | { type: 'text'; selected: string[] }
  | { type: 'cancel' }

export function questionOptionsInDisplayOrder(options: readonly QuestionOption[]): DisplayOption[] {
  const indexed = options.map((option, index) => ({ option, index }))
  return [...indexed.filter(({ option }) => option.recommended), ...indexed.filter(({ option }) => !option.recommended)]
}

function recommendedSelectTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: text => selectionText(theme, text),
    selectedText: text => {
      const marker = text.lastIndexOf(RECOMMENDED)
      if (marker < 0) return selectionText(theme, text.replace(/^→/, '❯'))
      const afterMarker = marker + RECOMMENDED.length
      return selectionText(theme, text.slice(0, marker).replace(/^→/, '❯')) + theme.fg('warning', RECOMMENDED) + selectionText(theme, text.slice(afterMarker))
    },
    description: text => theme.fg('muted', text),
    scrollInfo: text => theme.fg('dim', text),
    noMatch: text => theme.fg('warning', text.replace('commands', 'options'))
  }
}

class QuestionPickerContent implements Component, Focusable {
  private list!: SelectList
  private selectedIndexes: number[]
  private focusedValue = false
  private readonly displayOptions: DisplayOption[]

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly options: readonly QuestionOption[],
    private readonly multiSelect: boolean,
    private readonly allowText: boolean,
    selected: readonly string[],
    private readonly done: (result: QuestionPickerResult) => void
  ) {
    this.displayOptions = questionOptionsInDisplayOrder(options)
    this.selectedIndexes = []
    const remaining = [...selected]
    options.forEach((option, index) => {
      const selectedIndex = remaining.indexOf(option.label)
      if (selectedIndex >= 0) {
        this.selectedIndexes.push(index)
        remaining.splice(selectedIndex, 1)
      }
    })
    this.rebuild()
  }

  get focused(): boolean { return this.focusedValue }
  set focused(value: boolean) { this.focusedValue = value }

  private labels(): string[] {
    return this.selectedIndexes.map(index => this.options[index]!.label)
  }

  private rebuild(): void {
    const selectedValue = this.list?.getSelectedItem()?.value
    const items = this.displayOptions.map(({ option }, displayIndex) => ({
      value: `option:${displayIndex}`,
      label: `${displayIndex + 1}. ${this.selectedIndexes.includes(this.displayOptions[displayIndex]!.index) ? '✓ ' : ''}${option.label}${option.recommended ? ` ${RECOMMENDED}` : ''}`,
      description: option.description
    }))
    if (this.allowText) items.push({ value: 'write', label: 'Write an answer', description: undefined })
    if (this.multiSelect) items.push({ value: 'submit', label: 'Submit choices', description: undefined })

    const maxVisible = Math.min(12, Math.max(1, Math.floor(this.tui.terminal.rows * 0.6) - 5))
    const theme = recommendedSelectTheme(this.theme)
    this.list = new SelectList(items, maxVisible, theme, {
      minPrimaryColumnWidth: 1,
      maxPrimaryColumnWidth: 60,
      truncatePrimary: ({ text, maxWidth, isSelected }) => {
        const marker = text.lastIndexOf(RECOMMENDED)
        if (marker < 0) return truncateToWidth(text, maxWidth, '')
        const label = text.slice(0, marker).trimEnd()
        const suffix = text.slice(marker)
        const suffixWidth = visibleWidth(suffix)
        const shortened = suffixWidth >= maxWidth ? truncateToWidth(suffix, maxWidth, '') : `${truncateToWidth(label, Math.max(1, maxWidth - suffixWidth), '…')} ${suffix}`
        if (isSelected) return shortened
        const shortenedMarker = shortened.lastIndexOf(RECOMMENDED)
        return shortenedMarker < 0
          ? shortened
          : shortened.slice(0, shortenedMarker) + this.theme.fg('warning', shortened.slice(shortenedMarker))
      }
    })
    if (selectedValue) {
      const index = items.findIndex(item => item.value === selectedValue)
      if (index >= 0) this.list.setSelectedIndex(index)
    }
    this.list.onSelect = item => {
      if (item.value === 'write') {
        this.done({ type: 'text', selected: this.labels() })
        return
      }
      if (item.value === 'submit') {
        this.done({ type: 'answer', selected: this.labels() })
        return
      }
      const displayIndex = Number(item.value.slice('option:'.length))
      const originalIndex = this.displayOptions[displayIndex]?.index
      if (originalIndex === undefined) return
      if (!this.multiSelect) {
        this.done({ type: 'answer', selected: [this.options[originalIndex]!.label] })
        return
      }
      const selectedIndex = this.selectedIndexes.indexOf(originalIndex)
      if (selectedIndex >= 0) this.selectedIndexes.splice(selectedIndex, 1)
      else this.selectedIndexes.push(originalIndex)
      this.rebuild()
      this.tui.requestRender()
    }
    this.list.onCancel = () => this.done({ type: 'cancel' })
  }

  invalidate(): void { this.list.invalidate() }
  handleInput(data: string): void {
    if (/^[1-9]$/.test(data)) {
      const index = Number(data) - 1
      if (index >= 0 && index < this.displayOptions.length) {
        this.list.setSelectedIndex(index)
        this.list.handleInput('\r')
        return
      }
    }
    this.list.handleInput(data === 'j' ? '\x1b[B' : data === 'k' ? '\x1b[A' : data)
  }

  render(width: number): string[] {
    return this.list.render(width).map(line => {
      const bounded = truncateToWidth(line, width, '')
      return stripTerminalSequences(line).startsWith('❯') ? selectedRow(bounded, width, this.theme) : bounded
    })
  }
}

export function createQuestionPicker(
  tui: TUI,
  theme: Theme,
  title: string,
  question: string | undefined,
  options: readonly QuestionOption[],
  multiSelect: boolean,
  allowText: boolean,
  selected: readonly string[],
  done: (result: QuestionPickerResult) => void
): DialogPanel {
  const content = new QuestionPickerContent(tui, theme, options, multiSelect, allowText, selected, done)
  const hint = multiSelect ? '↑/↓ select · Enter toggle · Submit choices · Esc cancel' : '↑/↓ select · Enter choose · Esc cancel'
  const panel = new DialogPanel(title, content, () => theme, hint, question)
  panel.centered = centeredDialogHost(tui) && dialogFits(tui.terminal.columns, tui.terminal.rows)
  panel.maxRows = () => Math.max(3, Math.floor(tui.terminal.rows * 0.8))
  return panel
}
