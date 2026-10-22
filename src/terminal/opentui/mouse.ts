export interface OpenTuiMouseInput {
  type: 'move' | 'up' | 'scroll'
  x: number
  y: number
  button: number
  modifiers: { shift: boolean; alt: boolean; ctrl: boolean }
  scroll?: { direction: 'up' | 'down' | 'left' | 'right'; delta: number }
}
