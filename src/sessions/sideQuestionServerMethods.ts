import type { Harness } from '../harness'
import { invalid } from '../core/errors'
import type { Handler } from '../server/rpc'
import type { SideQuestionStartInput } from './sideQuestions'

export function sideQuestionServerMethods(harness: Harness): Record<string, Handler> {
  return {
    'sideQuestions.start': params => harness.sideQuestions.start(params as SideQuestionStartInput),
    'sideQuestions.read': params => {
      if (typeof params.runId !== 'string' || typeof params.sessionId !== 'string') throw invalid('A side-question run and session id are required.')
      const afterSequence = params.afterSequence === undefined ? -1 : params.afterSequence
      if (typeof afterSequence !== 'number') throw invalid('A side-question event sequence is required.')
      return harness.sideQuestions.read(params.runId, params.sessionId, afterSequence)
    },
    'sideQuestions.interrupt': params => {
      if (typeof params.runId !== 'string' || typeof params.sessionId !== 'string') throw invalid('A side-question run and session id are required.')
      return harness.sideQuestions.interrupt(params.runId, params.sessionId)
    }
  }
}
