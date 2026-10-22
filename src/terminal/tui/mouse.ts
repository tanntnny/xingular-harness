import type { TuiMouseEvent } from '@earendil-works/pi-tui'

export type TerminalMouseInput = TuiMouseEvent

export function isPrimaryClick(event: TerminalMouseInput): boolean {
  return event.type === 'click' && event.button === 'left'
}
