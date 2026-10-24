import type { Harness } from '../harness'
import type { Handler } from '../server/rpc'
import { optional, text } from '../server/params'
import * as notes from './notes'

export function wikiServerMethods(harness: Harness): Record<string, Handler> {
  const root = (): string => harness.env.root
  return {
    'wiki.list': (params) => notes.list(root(), params.project === undefined ? {} : { project: optional(params, 'project') }),
    'wiki.read': (params) => notes.read(root(), text(params, 'path')),
    'wiki.write': (params) => {
      const note = notes.write(root(), text(params, 'path'), typeof params.text === 'string' ? params.text : '', { expectedUpdatedAt: optional(params, 'expectedUpdatedAt') })
      harness.bus.emit({ type: 'wiki.changed' })
      return note
    },
    'wiki.remove': (params) => {
      notes.remove(root(), text(params, 'path'))
      harness.bus.emit({ type: 'wiki.changed' })
    },
    'wiki.search': (params) => notes.search(root(), typeof params.query === 'string' ? params.query : '', { project: optional(params, 'project'), limit: typeof params.limit === 'number' ? params.limit : undefined }),
    'wiki.graph': () => notes.graph(root()),
    'wiki.versions': (params) => notes.versions(root(), text(params, 'path')),
    'wiki.version': (params) => notes.version(root(), text(params, 'path'), text(params, 'id')),
    'wiki.ensureProject': () => {
      notes.ensureLayout(root(), harness.env.productName)
      harness.bus.emit({ type: 'wiki.changed' })
    }
  }
}
