/** A typed failure: a stable code, a message a person can read, and an optional hint on what to do next. */
export class HarnessError extends Error {
  readonly code: string
  readonly retryHint: string | null

  constructor(code: string, message: string, retryHint: string | null = null) {
    super(message)
    this.name = 'HarnessError'
    this.code = code
    this.retryHint = retryHint
  }

  withHint(hint: string): HarnessError {
    return new HarnessError(this.code, this.message, hint)
  }
}

export const invalid = (message: string): HarnessError => new HarnessError('invalid_request', message)
export const notFound = (what: string): HarnessError => new HarnessError('not_found', `${what} was not found.`)

export interface ErrorShape {
  code: string
  message: string
  retryHint?: string | null
}

export function toErrorShape(error: unknown, fallbackCode = 'harness_error'): ErrorShape {
  if (error instanceof HarnessError) return { code: error.code, message: error.message, retryHint: error.retryHint }
  const code = (error as { code?: unknown } | null)?.code
  if (error instanceof Error && typeof code === 'string' && code.startsWith('E')) return { code: 'io_error', message: error.message }
  return { code: fallbackCode, message: error instanceof Error ? error.message : String(error) }
}
