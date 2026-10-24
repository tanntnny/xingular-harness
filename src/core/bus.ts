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

let logSink: ((text: string) => void) | null = null

/**
 * Sends diagnostics somewhere other than stderr, or back to stderr with `null`. A host whose stderr is
 * the terminal a frontend is drawing on must not write into it, so it sets a sink.
 */
export function setLogSink(sink: ((text: string) => void) | null): void {
  logSink = sink
}

/** One line of diagnostics. Diagnostics go to stderr by default; stdout may be carrying a protocol. */
export function logLine(text: string): void {
  if (logSink) logSink(text)
  else process.stderr.write(`${text}\n`)
}

/** Redacts common credentials and URL query values before diagnostic text is persisted or shown. */
export function redactLogText(text: string): string {
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:authorization|proxy-authorization|cookie|set-cookie|x-[\w-]{0,64}(?:token|key)|[\w-]{0,64}(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|client[_-]?secret))["']?\s*[:=]\s*["']?)[^"'\s,;]+/gi, '$1[redacted]')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{16,}\b/gi, '[redacted]')
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (raw) => {
      const punctuation = /[),.;!?]+$/.exec(raw)?.[0] ?? ''
      const address = punctuation ? raw.slice(0, -punctuation.length) : raw
      try {
        const url = new URL(address)
        url.username = ''
        url.password = ''
        url.search = ''
        url.hash = ''
        return `${url.href}${punctuation}`
      } catch {
        return raw
      }
    })
}

/** Records useful failure detail without persisting credentials or response bodies. */
export function logDiagnostic(scope: string, error: unknown, metadata: Record<string, unknown> = {}): void {
  const failure = error instanceof Error ? error : new Error(String(error))
  const details = {
    ...metadata,
    message: failure.message,
    ...(failure.stack ? { stack: failure.stack } : {})
  }
  let serialized: string
  try {
    serialized = JSON.stringify(details)
  } catch {
    serialized = JSON.stringify({ message: failure.message, stack: failure.stack })
  }
  logLine(`[harness] ${redactLogText(scope)} ${redactLogText(serialized)}`)
}

export function log(...parts: unknown[]): void {
  logLine(`[harness] ${parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')}`)
}
