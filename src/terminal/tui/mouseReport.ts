// A mouse report that the input parser split across its timeout loses its `ESC[` prefix: the orphaned
// prefix is flushed as an unknown response and the rest is decoded as keystrokes. These helpers keep
// that tail out of text fields, without touching what a person types or pastes.
import { Input } from '@earendil-works/pi-tui'

/** A leaked report is echoed within one read; ten characters in this window is 50 characters a second. */
export const MOUSE_REPORT_TAIL_WINDOW_MS = 200

const REPORT = /^<\d{1,3};\d{1,4};\d{1,4}[Mm]$/
const PARTIAL = /^<\d{0,3}(;\d{0,4}){0,2}$/
const WHOLE = /^(?:\x1b\[)?<\d{1,3};\d{1,4};\d{1,4}[Mm]$/
const SGR_REPORT = /\x1b\[<\d+;\d+;\d+[Mm]|\\u001b\[<\d+;\d+;\d+[Mm]|\\x1b\[<\d+;\d+;\d+[Mm]/g
const X10_REPORT = /\x1b\[M[\u0020-\u00ff]{3}/g

export interface MouseReportMatch {
  /** The whole report the keys spelled, without its `ESC[` prefix. */
  report: string
  /** What a text field already held before the completing sequence. */
  inserted: string
}

/**
 * Follows the printable characters of one report. A caller that receives the completing sequence
 * before insertion removes `inserted`; a caller that receives it after insertion removes `report`.
 */
export class MouseReportTail {
  private text = ''
  private startedAt = 0

  push(sequence: string, nowMs = Date.now()): MouseReportMatch | undefined {
    if (WHOLE.test(sequence)) {
      this.reset()
      return { report: sequence.replace(/^\x1b\[/, ''), inserted: '' }
    }
    if (sequence.length !== 1) {
      this.reset()
      return undefined
    }
    if (sequence === '<') {
      this.text = '<'
      this.startedAt = nowMs
      return undefined
    }
    if (!this.text) return undefined
    if (nowMs - this.startedAt > MOUSE_REPORT_TAIL_WINDOW_MS) {
      this.reset()
      return undefined
    }
    const next = this.text + sequence
    if (REPORT.test(next)) {
      const inserted = this.text
      this.reset()
      return { report: next, inserted }
    }
    if (!PARTIAL.test(next)) {
      this.reset()
      return undefined
    }
    this.text = next
    return undefined
  }

  reset(): void {
    this.text = ''
    this.startedAt = 0
  }
}

/** A single-line input that drops a leaked mouse report instead of keeping it as text. */
export class MouseSafeInput extends Input {
  private readonly mouseTail = new MouseReportTail()

  override handleInput(data: string): void {
    super.handleInput(data)
    const match = this.mouseTail.push(data)
    if (!match) return
    const value = this.getValue()
    if (value.endsWith(match.report)) this.setValue(value.slice(0, -match.report.length))
  }

  override setValue(value: string): void {
    this.mouseTail.reset()
    super.setValue(value)
  }
}

/**
 * Removes reports from text that is about to be printed. A bare `<\d;\d;\d>M` stays: once recorded it
 * is content, and rewriting it would misreport what a run received.
 */
export function stripMouseReports(text: string): string {
  return text.replace(SGR_REPORT, '').replace(X10_REPORT, '')
}
