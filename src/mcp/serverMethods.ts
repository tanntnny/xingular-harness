import type { Harness } from '../harness'
import type { Handler } from '../server/rpc'
import { validateScopeIds } from './connections'
import { optional, text } from '../server/params'

export function connectedAppServerMethods(harness: Harness): Record<string, Handler> {
  const apps = harness.apps
  return {
    'connections.list': () => apps.connections.list(),
    'connections.forScope': (params) => apps.connections.forScope({ agentId: optional(params, 'agentId'), projectId: optional(params, 'projectId') }),
    'connections.save': (params) => apps.save(params.input),
    'connections.allowTool': (params) => apps.connections.allowTool(text(params, 'connectionId'), text(params, 'tool')),
    'connections.remove': (params) => apps.remove(text(params, 'connectionId')),
    'connections.test': (params) => apps.test(text(params, 'connectionId')),
    'connections.signIn': (params) => apps.signIn(text(params, 'connectionId')),
    'connections.signOut': (params) => apps.signOut(text(params, 'connectionId')),
    'connections.runContext': (params) => apps.runContext(text(params, 'runId')),
    'connections.refreshSource': (params) => apps.refreshSource(text(params, 'runId'), text(params, 'traceId'), text(params, 'sourceUri')),
    'connections.setAgentScope': (params) => apps.setAgentScope(params.creator ?? {}, text(params, 'agentId'), Array.isArray(params.ids) ? params.ids : []),
    'connections.removeAgentScope': (params) => apps.removeAgentScope(text(params, 'agentId')),
    'connections.revision': () => apps.connections.revision(),
    'connections.appClients': () => apps.appClients(),
    'connections.validateScope': (params) => validateScopeIds(apps.connections.list(), { agentId: optional(params, 'agentId'), projectId: optional(params, 'projectId') }, Array.isArray(params.ids) ? params.ids : [])
  }
}
