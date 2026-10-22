// The block above the composer that offers a finished plan: implement it, or revise it. It takes
// only the keys that move through it or confirm it, and only while the draft is empty, so typing
// always reaches the composer.
export type PlanChoiceAction = 'implement' | 'edit' | 'dismiss' | 'moved'

export interface PlanChoiceView {
  title: string
  index: number
}

export interface PlanChoiceKey {
  name?: string
}

const ROWS = ['implement', 'edit'] as const

export class PlanChoice {
  private title: string | undefined
  private index = 0

  show(title: string): void {
    this.title = title
    this.index = 0
  }

  clear(): void {
    this.title = undefined
    this.index = 0
  }

  get view(): PlanChoiceView | null {
    return this.title === undefined ? null : { title: this.title, index: this.index }
  }

  select(index: number): boolean {
    if (this.title === undefined || !Number.isInteger(index) || index < 0 || index >= ROWS.length) return false
    this.index = index
    return true
  }

  /** The action a key takes, or null when the key belongs to the composer. */
  handle(key: PlanChoiceKey, draftEmpty: boolean): PlanChoiceAction | null {
    if (this.title === undefined || !draftEmpty) return null
    if (key.name === 'up' || key.name === 'down') {
      this.index = (this.index + (key.name === 'down' ? 1 : -1) + ROWS.length) % ROWS.length
      return 'moved'
    }
    if (key.name === 'return' || key.name === 'enter') return ROWS[this.index]!
    if (key.name === 'escape') return 'dismiss'
    return null
  }
}
