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
  let timeout = Math.floor(requested)
  if (timeout < 1) return { ok: false, message: 'timeout must be a positive number of seconds.' }
  // Some models send milliseconds (Claude Code's own bash tool takes them; GPT 6 Luna sends 120000).
  // A value that only fits as milliseconds is read as milliseconds, instead of refusing every
  // command that model sends.
  if (timeout > COMMAND_TIMEOUT_MAX_SECONDS && timeout >= 1_000 && timeout / 1_000 <= COMMAND_TIMEOUT_MAX_SECONDS) timeout = Math.ceil(timeout / 1_000)
  if (timeout > COMMAND_TIMEOUT_MAX_SECONDS) return { ok: false, message: `timeout is in seconds, and a command may run for at most ${COMMAND_TIMEOUT_MAX_SECONDS} seconds. Split it into smaller commands.` }
  if (timeout > COMMAND_TIMEOUT_CEILING_SECONDS && !why) {
    return { ok: false, message: `A command over ${COMMAND_TIMEOUT_CEILING_SECONDS} seconds needs a reason: pass reason with why it cannot be narrowed or run in smaller steps.` }
  }
  return { ok: true, timeout }
}

/** A command's result when it was stopped by the budget rather than finishing. */
export function commandTimeoutText(seconds: number, output: string): string {
  return `The command was stopped after ${seconds} seconds by the command budget. Its output so far:\n${output || '(none)'}\n\nNarrow it: one test file, --grep for the failing case, or a line range, then run the full set at a checkpoint.`
}

const NATIVE_TIMEOUT = /Command timed out after (\d+) seconds$/u

/**
 * What the model reads when the shell tool's own timeout ended a command (INV-TOOL-10). The native
 * text already carries the partial output; this adds what the budget did and how to ask for a
 * different wait. A command that waits for an outside event (a poll, a watcher) keeps its own
 * clock: a budget equal to that clock cuts it off just before it answers, so it needs a longer one.
 */
export function explainNativeTimeout(message: string): string | null {
  const match = NATIVE_TIMEOUT.exec(message)
  if (!match) return null
  const seconds = Number(match[1])
  return `${message}\n\nThe command budget stopped it after ${seconds} seconds; the command did not finish. Narrow it (one test file, --grep, a line range) and run the full set at a checkpoint. If it intentionally waits for an outside event and has its own wait of about ${seconds} seconds, run it again with a timeout longer than that wait (at most ${COMMAND_TIMEOUT_MAX_SECONDS}, with a reason above ${COMMAND_TIMEOUT_CEILING_SECONDS}), or give the command a shorter wait of its own.`
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
