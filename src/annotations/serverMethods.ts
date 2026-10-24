import type { Harness } from '../harness'
import type { Handler } from '../server/rpc'
import { invalid } from '../core/errors'
import { inspectStep } from './inspect'
import * as pageNotes from './store'
import { PAGE_SCRIPT } from './pageScript'
import { optional, text, type Params } from '../server/params'

export function annotationServerMethods(harness: Harness): Record<string, Handler> {
  const root = (): string => harness.env.root
  return {
    'annotations.list': (params: Params) => pageNotes.list(root(), {
      url: optional(params, 'url'), query: optional(params, 'query'),
      status: params.status === 'open' || params.status === 'resolved' ? params.status : null,
      ...(typeof params.offset === 'number' ? { offset: params.offset } : {}), ...(typeof params.limit === 'number' ? { limit: params.limit } : {})
    }),
    'annotations.read': (params: Params) => pageNotes.read(root(), text(params, 'id')),
    'annotations.create': (params: Params) => pageNotes.create(root(), { source: params.source, target: params.target, body: params.body, tags: params.tags }),
    'annotations.update': (params: Params) => {
      if (typeof params.expectedVersion !== 'number') throw invalid('expectedVersion is required.')
      return pageNotes.update(root(), text(params, 'id'), params.expectedVersion, (params.patch ?? {}) as pageNotes.NotePatch)
    },
    'annotations.delete': (params: Params) => {
      if (typeof params.expectedVersion !== 'number') throw invalid('expectedVersion is required.')
      pageNotes.remove(root(), text(params, 'id'), params.expectedVersion)
      return {}
    },
    'annotations.share': (params: Params) => pageNotes.share(root(), text(params, 'id'), params.principal ?? {}, optional(params, 'binding')),
    'annotations.unshare': (params: Params) => pageNotes.unshare(root(), text(params, 'id'), params.principal ?? {}),
    'annotations.revokeBinding': (params: Params) => ({ revoked: pageNotes.revokeBinding(root(), text(params, 'binding')) }),
    'annotations.import': (params: Params) => pageNotes.importNotes(root(), Array.isArray(params.notes) ? params.notes : []),
    'annotations.pageScript': () => ({ script: PAGE_SCRIPT }),
    'annotations.queue': (params: Params) => harness.pageNotes.queue(text(params, 'id'), typeof params.expectedVersion === 'number' ? params.expectedVersion : undefined, text(params, 'sessionId'), { autoSend: params.autoSend === true }),
    'annotations.dequeue': (params: Params) => harness.pageNotes.dequeue(text(params, 'id'), typeof params.expectedVersion === 'number' ? params.expectedVersion : undefined),
    'annotations.confirm': (params: Params) => harness.pageNotes.confirm(text(params, 'id'), typeof params.expectedVersion === 'number' ? params.expectedVersion : undefined),
    'annotations.queued': (params: Params) => ({ notes: pageNotes.queued(root(), text(params, 'sessionId')) }),
    'annotations.createAndAct': (params: Params) => {
      const action = params.action
      if (action !== 'save' && action !== 'queue' && action !== 'send') throw invalid('action is save, queue or send.')
      const input = (params.note ?? {}) as Params
      // A host vouches for the comment only when it came from its own UI or an isolated script world.
      return harness.pageNotes.createAndAct({ source: input.source, target: input.target, body: input.body, tags: input.tags } as pageNotes.NoteInput, action, optional(params, 'sessionId'), params.trusted === true)
    },
    'annotations.compose': (params: Params) => harness.pageNotes.compose(text(params, 'sessionId'), Array.isArray(params.ids) ? params.ids.filter((id): id is string => typeof id === 'string') : null),
    'annotations.delivered': (params: Params) => ({ notes: harness.pageNotes.delivered(Array.isArray(params.ids) ? params.ids.filter((id): id is string => typeof id === 'string') : [], text(params, 'sessionId'), text(params, 'runId')) }),
    'annotations.send': (params: Params) => harness.pageNotes.send(text(params, 'sessionId'), { ids: Array.isArray(params.ids) ? params.ids.filter((id): id is string => typeof id === 'string') : null }),
    'annotations.capture.attach': (params: Params) => {
      const kind = params.kind
      if (kind !== 'web' && kind !== 'cdp' && kind !== 'bridge') throw invalid('kind is web, cdp or bridge.')
      return harness.noteCapture.attach(text(params, 'key'), kind === 'cdp' ? { kind, endpoint: text(params, 'endpoint'), name: optional(params, 'name') } : kind === 'bridge' ? { kind, name: optional(params, 'name') } : { kind })
    },
    'annotations.capture.target': async (params: Params) => ({ ...harness.noteCapture.describe(text(params, 'key')), windows: await harness.noteCapture.windows(text(params, 'key')).catch(() => []) }),
    'annotations.capture.selectWindow': async (params: Params) => { await harness.noteCapture.selectWindow(text(params, 'key'), text(params, 'window')); return {} },
    'annotations.capture.open': (params: Params) => harness.noteCapture.open(text(params, 'key'), optional(params, 'url')),
    'annotations.capture.inspect': (params: Params) => harness.noteCapture.inspect(text(params, 'key')),
    'annotations.capture.stopInspect': async (params: Params) => { await harness.noteCapture.stopInspect(text(params, 'key')); return {} },
    'annotations.capture.next': (params: Params) => inspectStep(harness.noteCapture, harness.pageNotes, text(params, 'key'), optional(params, 'sessionId'), optional(params, 'surface') ?? 'host'),
    'annotations.capture.release': async (params: Params) => { await harness.noteCapture.release(text(params, 'key')); return {} },
    'annotations.bridge.start': () => harness.noteCapture.bridge.start()
  }
}
