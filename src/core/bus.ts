// Notices: what the harness tells whoever embeds it. Run events travel separately, through the
// run tracker; a notice says that some state changed and should be read again.

export interface Notice {
  /** `accounts.changed`, `accounts.login`, `accounts.loginEvent`, `wiki.changed`, `wiki.maintenance`, … */
  type: string
  [key: string]: unknown
}

export type NoticeListener = (notice: Notice) => void

export class Bus {
  private readonly listeners = new Set<NoticeListener>()

  on(listener: NoticeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(notice: Notice): void {
    for (const listener of this.listeners) {
      try {
        listener(notice)
      } catch (error) {
        log('a notice listener failed', error instanceof Error ? error.message : String(error))
      }
    }
  }
}

/** Diagnostics go to stderr; stdout may be carrying a protocol. */
export function log(...parts: unknown[]): void {
  process.stderr.write(`[harness] ${parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')}\n`)
}
