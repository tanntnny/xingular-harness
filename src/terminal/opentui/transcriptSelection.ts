import type { Selection } from '@opentui/core'

interface SelectionNode {
  parent: SelectionNode | null
}

type TranscriptSelection = Pick<Selection, 'behavior' | 'anchor' | 'focus' | 'selectedRenderables' | 'getSelectedText'>

function isWithin(node: SelectionNode, ancestor: SelectionNode): boolean {
  let current: SelectionNode | null = node
  while (current) {
    if (current === ancestor) return true
    current = current.parent
  }
  return false
}

export function transcriptSelectionText(
  selection: TranscriptSelection,
  transcript: SelectionNode | undefined
): string | undefined {
  const selected = selection.selectedRenderables
  if (!transcript || selected.length === 0 || !selected.every(node => isWithin(node, transcript))) return undefined
  if (selection.behavior === 'cell' && selection.anchor.x === selection.focus.x && selection.anchor.y === selection.focus.y) return undefined

  const text = selection.getSelectedText()
  return text.trim() ? text : undefined
}
