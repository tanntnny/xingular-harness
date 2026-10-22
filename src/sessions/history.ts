// Which native history a session opens. The prompt compiler compares against this file and Pi
// opens it, so both always see the same conversation, including after a restart.
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

import { HarnessError } from '../core/errors'
import { sessionFile } from '../prompt/compile'

export interface HistorySelection {
  sessionDir: string
  /** A recorded history to continue, with the native session id it must still carry. */
  resume?: { sessionFile?: string | null; nativeSessionId?: string | null } | null
}

const unavailable = (): HarnessError => new HarnessError('native_resume_unavailable', 'The saved conversation is unavailable; this reply cannot be continued.')

/** The session file's own id, when the file is a native history inside `sessionDir`. */
function nativeId(sessionDir: string, path: string): string {
  const file = realpathSync(path)
  const within = relative(realpathSync(sessionDir), file)
  if (within.startsWith('..') || isAbsolute(within) || !file.endsWith('.jsonl')) throw new Error('Outside history')
  const header = JSON.parse(readFileSync(file, 'utf8').split('\n', 1)[0]) as { type?: string; id?: string }
  if (header.type !== 'session' || !header.id) throw new Error('Missing session identity')
  return header.id
}

/**
 * The history to open: the recorded one for an explicit continuation, else the newest in the
 * session's folder, else none (a fresh history). An explicit continuation never falls back to
 * another session or a fresh history.
 */
export function selectHistory(selection: HistorySelection): string | null {
  const resume = selection.resume
  if (resume?.sessionFile || resume?.nativeSessionId) {
    try {
      if (!resume.sessionFile || !resume.nativeSessionId) throw new Error('Missing history')
      if (nativeId(selection.sessionDir, resume.sessionFile) !== resume.nativeSessionId) throw new Error('Different history')
      return realpathSync(resume.sessionFile)
    } catch {
      throw unavailable()
    }
  }
  const newest = sessionFile(selection.sessionDir)
  if (!newest) return null
  try {
    nativeId(selection.sessionDir, newest)
    return realpathSync(newest)
  } catch {
    throw unavailable()
  }
}

/** The native history in `sessionDir` that carries this session id, or null. */
export function findHistory(sessionDir: string, nativeSessionId: string): string | null {
  let names: string[]
  try {
    names = readdirSync(sessionDir).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return null
  }
  for (const name of names) {
    try {
      if (nativeId(sessionDir, join(sessionDir, name)) === nativeSessionId) return realpathSync(join(sessionDir, name))
    } catch {
      // Not a history file; keep looking.
    }
  }
  return null
}
