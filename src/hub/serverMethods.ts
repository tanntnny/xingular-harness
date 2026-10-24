import type { Harness } from '../harness'
import type { Handler } from '../server/rpc'
import { text } from '../server/params'

export function hubServerMethods(harness: Harness): Record<string, Handler> {
  return {
    'hub.list': (params) => harness.hub.list(params.refresh === true),
    'hub.get': (params) => harness.hub.get(text(params, 'id'), text(params, 'version'), params.preview === true),
    'hub.install': (params) => harness.hub.install(text(params, 'id'), text(params, 'version')),
    'hub.preview': (params) => harness.hub.preview(text(params, 'id'), text(params, 'version'), typeof params.offset === 'number' ? params.offset : 0),
    'hub.uninstall': (params) => harness.hub.uninstall(text(params, 'id'), text(params, 'version')),
    'hub.readDocument': (params) => harness.hub.readDocument(text(params, 'id'), text(params, 'version'))
  }
}
