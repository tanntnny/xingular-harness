import type { Harness } from '../harness'
import type { Handler } from '../server/rpc'
import * as recall from './recall'
import { text } from '../server/params'

export function historyServerMethods(harness: Harness): Record<string, Handler> {
  return {
    'recall.search': (params) => recall.searchAll(harness.env, typeof params.query === 'string' ? params.query : '', params.filter ?? {}),
    'recall.read': (params) => recall.read(harness.env.root, text(params, 'runId'))
  }
}
