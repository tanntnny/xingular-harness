import type { Harness } from '../harness'
import type { Handler } from '../server/rpc'
import { text } from '../server/params'

export function webServerMethods(harness: Harness): Record<string, Handler> {
  return {
    'web.status': () => harness.world.searchStatus(),
    'web.setKey': (params) => harness.world.setSearchKey(text(params, 'provider'), typeof params.key === 'string' ? params.key : null)
  }
}
