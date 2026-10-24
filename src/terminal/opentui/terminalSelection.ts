import type { Selection } from '@opentui/core'

type TerminalSelection = Pick<Selection, 'behavior' | 'anchor' | 'focus' | 'selectedRenderables' | 'getSelectedText'>

export function terminalSelectionText(selection: TerminalSelection): string | undefined {
  if (selection.selectedRenderables.length === 0) return undefined
  if (selection.behavior === 'cell' && selection.anchor.x === selection.focus.x && selection.anchor.y === selection.focus.y) return undefined

  const text = selection.getSelectedText()
  return text.trim() ? text : undefined
}
