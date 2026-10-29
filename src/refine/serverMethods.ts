import type { Harness } from '../harness'
import type { Handler } from '../server/rpc'
import { optional, text } from '../server/params'
import { readSummary } from './runner'

export function refinementServerMethods(harness: Harness): Record<string, Handler> {
  const root = (): string => harness.env.root
  return {
    'refine.start': (params) => harness.refine.start({ task: params.task, k: typeof params.k === 'number' ? params.k : 1, mode: params.mode === 'sequential' ? 'sequential' : 'parallel', improver: params.improver ?? {}, executor: params.executor ?? undefined, baseVersion: optional(params, 'baseVersion'), retainWorkspaces: params.retainWorkspaces === true, id: optional(params, 'id') ?? undefined }),
    'refine.fromRun': (params) => harness.refine.taskFromRun({ runId: optional(params, 'runId'), sessionId: optional(params, 'sessionId'), guidance: optional(params, 'guidance') }),
    'refine.get': (params) => harness.refine.get(text(params, 'id')),
    'refine.list': (params) => harness.refine.list({ scope: optional(params, 'scope'), limit: typeof params.limit === 'number' ? params.limit : undefined }),
    'refine.running': () => harness.refine.running(),
    'refine.cancel': async (params) => {
      await harness.refine.cancel(text(params, 'id'))
      return readSummary(root(), text(params, 'id'))
    },
    'refine.candidates': (params) => harness.refine.candidates(text(params, 'id')),
    'refine.candidateDiff': (params) => harness.refine.candidateDiff(text(params, 'id'), text(params, 'label')),
    'refine.candidateOutput': (params) => harness.refine.candidateOutput(text(params, 'id'), text(params, 'label')),
    'refine.adopt': (params) => harness.refine.adopt(text(params, 'id'), { label: optional(params, 'label'), tag: optional(params, 'tag') }),
    'library.list': (params) => harness.refine.library(text(params, 'scope')),
    'library.read': (params) => harness.refine.libraryEntry(text(params, 'scope'), text(params, 'area'), text(params, 'task')),
    'library.forget': (params) => harness.refine.forget(text(params, 'scope'), text(params, 'area'), Array.isArray(params.tasks) ? params.tasks : [])
  }
}
