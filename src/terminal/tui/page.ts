import type { TuiMouseEventResult } from '@earendil-works/pi-tui'

import type { TabInfo } from './chrome'
import type { TerminalMouseInput } from './mouse'

export interface TerminalPage {
  presentation?: 'centered' | 'fullscreen'
  ownsNavigation?: boolean
  selectTab?(id: string): void
  tabs(): readonly TabInfo[]
  activeTab(): string
  render(width: number, rows: number): string[]
  handleInput(data: string): boolean
  handleMouse?(event: TerminalMouseInput): TuiMouseEventResult | undefined
  hint(): string
  focused?: boolean
  activate?(): void
  dispose?(): void
}
