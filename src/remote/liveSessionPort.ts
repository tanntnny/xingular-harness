// What a paired phone reaches on a host's live session (PAR-018): the conversation's own runs, and
// the same follow-up, interrupt and decision calls a client terminal makes (INV-RC-3). It reads and
// acts only through `Sessions` and the run registry; it has no terminal behind it, so it keeps working
// after a window closes, and it serves a host's chat that never had one.
import { basename } from 'node:path'

import { HarnessError } from '../core/errors'
import type { RunRegistry } from '../sessions/registry'
import { LiveDecisions } from '../sessions/liveDecisions'
import { findRun, listRuns, readEvents } from '../sessions/runStore'
import type { Sessions } from '../sessions/sessions'
import type { RemoteSessionPort } from './service'

export interface LiveSessionPortOptions {
  sessionId: string
  root: string
  runs: RunRegistry
  sessions: Sessions
  productName: string
  allowTool(target: string): void
}

export function liveSessionPort(options: LiveSessionPortOptions): RemoteSessionPort {
  const { sessionId, root, runs, sessions } = options
  const status = () => sessions.live.status(sessionId)
  const decisions = new LiveDecisions({ root, runs, activeRun: () => status()?.activeRunId ?? null, allowTool: options.allowTool })
  const stopFollowing = decisions.follow(sessionId)
  // A subagent's or side question's run is not the conversation: the phone sees only the person's own.
  const own = new Map<string, boolean>()
  const isOwn = (runId: string): boolean => {
    let known = own.get(runId)
    if (known === undefined) {
      const record = findRun(root, runId)
      known = !!record && !record.relation && record.trigger !== 'side-question'
      if (own.size > 1000) own.clear()
      if (record) own.set(runId, known)
    }
    return known
  }
  return {
    sessionId,
    title: () => {
      const last = status()?.lastRunId
      const cwd = last ? findRun(root, last)?.workingDirectory : null
      return (cwd && basename(cwd)) || options.productName
    },
    send: async (text) => {
      // The harness starts a reply on an idle session and queues the message behind a running one.
      const result = await sessions.followUp(sessionId, text)
      return { runId: 'runId' in result ? result.runId : status()?.activeRunId ?? '' }
    },
    control: async (call, params) => {
      switch (call) {
        case 'terminal.interrupt': return decisions.interrupt()
        case 'terminal.approve': return decisions.approve(params)
        case 'terminal.answer': return decisions.answer(params)
        case 'terminal.answers': return decisions.answers(params)
        case 'terminal.pending.wait': return decisions.wait(params.revision)
        default: throw new HarnessError('unknown_method', `Unknown control ${String(call)}.`)
      }
    },
    history: () => {
      const native = status()?.nativeSessionId ?? null
      return listRuns(root, { sessionId })
        .filter((run) => (!native || run.nativeSessionId === native) && !run.relation && run.trigger !== 'side-question')
        .slice(0, 20)
        .reverse()
        .flatMap((run) => readEvents(root, run.id))
    },
    listen: (listener) => runs.listen((event) => {
      if (event.sessionId === sessionId && isOwn(event.runId)) listener(event)
    }),
    state: () => ({ ready: status() !== null, active: !!status()?.activeRunId }),
    close: () => {
      stopFollowing()
      decisions.dispose()
    }
  }
}
