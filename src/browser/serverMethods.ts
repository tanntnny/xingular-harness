import type { Harness } from '../harness'
import type { Handler } from '../server/rpc'
import { pick, type Params } from '../server/params'
import type { BrowserConfig } from './config'

export function browserServerMethods(harness: Harness): Record<string, Handler> {
  return {
    'browser.config': () => harness.world.browserConfig(),
    'browser.configure': (params: Params) => harness.world.configureBrowser(pick(params, ['headed', 'cdpUrl', 'executablePath', 'allowPrivate', 'allowedDomains']) as Partial<BrowserConfig>)
  }
}
