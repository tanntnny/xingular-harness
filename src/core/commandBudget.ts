// One command budget for every path that runs a shell command (PROP-0041). A blocking command is
// how a reply spends a quarter of an hour: a default keeps ordinary commands honest, a ceiling
// makes a long one an explicit choice, and a timeout returns what it saw instead of waiting.

/** What a command gets when the caller says nothing. */
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120
/** Past this, a call must say why it needs longer. */
export const COMMAND_TIMEOUT_CEILING_SECONDS = 300
/** The longest a single command may run at all. */
export const COMMAND_TIMEOUT_MAX_SECONDS = 900

export type CommandTimeout =
  | { ok: true; timeout: number }
  | { ok: false; message: string }

/** Resolves a requested timeout against the default, the ceiling and the maximum. */
export function resolveCommandTimeout(requested: unknown, reason: unknown): CommandTimeout {
  const why = typeof reason === 'string' ? reason.trim() : ''
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return { ok: true, timeout: DEFAULT_COMMAND_TIMEOUT_SECONDS }
  const timeout = Math.floor(requested)
  if (timeout < 1) return { ok: false, message: 'timeout must be a positive number of seconds.' }
  if (timeout > COMMAND_TIMEOUT_MAX_SECONDS) return { ok: false, message: `A command may run for at most ${COMMAND_TIMEOUT_MAX_SECONDS} seconds. Split it into smaller commands.` }
  if (timeout > COMMAND_TIMEOUT_CEILING_SECONDS && !why) {
    return { ok: false, message: `A command over ${COMMAND_TIMEOUT_CEILING_SECONDS} seconds needs a reason: pass reason with why it cannot be narrowed or run in smaller steps.` }
  }
  return { ok: true, timeout }
}

/** A command's result when it was stopped by the budget rather than finishing. */
export function commandTimeoutText(seconds: number, output: string): string {
  return `The command was stopped after ${seconds} seconds by the command budget. Its output so far:\n${output || '(none)'}\n\nNarrow it: one test file, --grep for the failing case, or a line range, then run the full set at a checkpoint.`
}

/**
 * Runs a command with a wall-clock budget. The abort reaches the live shell, so the promise
 * settles instead of leaving the reply blocked; a timeout is reported as a rejection the caller
 * turns into a tool result.
 */
export async function withCommandBudget<T>(run: () => Promise<T>, abort: (() => void) | undefined, seconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          try {
            abort?.()
          } catch {
            // The abort is best effort; the timeout still settles the reply.
          }
          reject(new Error(commandTimeoutText(seconds, '')))
        }, seconds * 1000)
        timer.unref?.()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
