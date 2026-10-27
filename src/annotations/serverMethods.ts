import type { Harness } from '../harness'
import type { Handler } from '../server/rpc'
import { invalid } from '../core/errors'
import { inspectStep } from './inspect'
import * as pageNotes from './store'
import { PAGE_SCRIPT } from './pageScript'
import { optional, text, type Params } from '../server/params'

const ids = (params: Params): string[] | null => Array.isArray(params.ids) ? params.ids.filter((id): id is string => typeof id === 'string') : null

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
    'annotations.pending': (params: Params) => ({ notes: pageNotes.pending(root(), text(params, 'sessionId')) }),
    'annotations.markPending': (params: Params) => harness.pageNotes.share(text(params, 'id'), typeof params.expectedVersion === 'number' ? params.expectedVersion : undefined, text(params, 'sessionId')),
    'annotations.confirm': (params: Params) => harness.pageNotes.confirm(text(params, 'id'), typeof params.expectedVersion === 'number' ? params.expectedVersion : undefined),
    'annotations.confirmAll': (params: Params) => ({ notes: harness.pageNotes.confirmAll(text(params, 'sessionId')) }),
    'annotations.clear': (params: Params) => ({ notes: harness.pageNotes.clear(text(params, 'sessionId')) }),
    'annotations.createAndAct': (params: Params) => {
      const action = params.action
      if (action !== 'save' && action !== 'send') throw invalid('action is save or send.')
      const input = (params.note ?? {}) as Params
      // A host vouches for the comment only when it came from its own UI or an isolated script world.
      return harness.pageNotes.createAndAct({ source: input.source, target: input.target, body: input.body, tags: input.tags } as pageNotes.NoteInput, action, optional(params, 'sessionId'), params.trusted === true)
    },
    'annotations.compose': (params: Params) => harness.pageNotes.compose(text(params, 'sessionId'), ids(params), optional(params, 'prompt')),
    'annotations.delivered': (params: Params) => ({ notes: harness.pageNotes.delivered(Array.isArray(params.ids) ? params.ids.filter((id): id is string => typeof id === 'string') : [], text(params, 'sessionId'), text(params, 'runId')) }),
    'annotations.send': (params: Params) => harness.pageNotes.send(text(params, 'sessionId'), { ids: ids(params), prompt: optional(params, 'prompt') }),
    'annotations.capture.attach': (params: Params) => {
      const kind = params.kind
      if (kind !== 'web' && kind !== 'cdp' && kind !== 'bridge') throw invalid('kind is web, cdp or bridge.')
      return harness.noteCapture.attach(text(params, 'key'), kind === 'cdp' ? { kind, endpoint: text(params, 'endpoint'), name: optional(params, 'name') } : kind === 'bridge' ? { kind, name: optional(params, 'name') } : { kind })
    },
    'annotations.capture.discover': async () => ({ apps: await harness.noteCapture.discover() }),
    'annotations.capture.launch': (params: Params) => harness.noteCapture.launchApp(text(params, 'key'), text(params, 'path'), Array.isArray(params.args) ? params.args.filter((arg): arg is string => typeof arg === 'string') : []),
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
