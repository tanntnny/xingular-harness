// One entry point for every memory, recall, and Wiki call a session makes, whichever way it
// reaches the harness (a Pi tool, the `xagent-wiki` command, the bundled MCP server).
import type { Bus } from '../core/bus'
import type { HarnessEnv } from '../core/env'
import { HarnessError } from '../core/errors'
import { launchText, load, render } from '../prompt/compile'
import * as api from './api'
import type { CallerContext } from './caller'
import * as recall from './recall'
import * as trajectory from './trajectory'
import { reindexQuietly } from './wikiIndex'

export type DispatchEnv = HarnessEnv & { bus?: Bus }

/** Runs one call and returns its reply as text for a model. */
export function dispatch(env: DispatchEnv, context: CallerContext, call: string, params: api.Params, contributions?: readonly string[]): string {
  switch (call) {
    case 'wiki.entrypoint': {
      const recorded = context.runId ? safely(() => load(env.root, context.runId!)) : null
      return recorded ? render(env, recorded) : launchText(env, context)
    }
    case 'recall.search':
      return recall.searchTool(env, context, params)
    case 'recall.read':
      return recall.readTool(env, context, params)
    case 'trajectory.search':
      return trajectory.searchTool(env, context, params)
    case 'trajectory.read':
      return trajectory.readTool(env, context, params)
    case 'memory.append':
    case 'memory.replace':
    case 'memory.rethink': {
      const text = api.memoryEdit(env, context, call, params)
      env.bus?.emit({ type: 'wiki.changed' })
      return text
    }
    case 'wiki.search':
      return api.search(env, context, params)
    case 'wiki.read':
      return api.read(env, context, params)
    case 'wiki.list':
      return api.list(env, params)
    case 'wiki.skill':
      return api.skill(env, context, params, contributions)
    case 'wiki.memory':
      return api.memories(env, context, params)
    case 'wiki.propose': {
      const text = api.propose(env, context, params)
      reindexQuietly(env.root)
      env.bus?.emit({ type: 'wiki.changed' })
      return text
    }
    default:
      throw new HarnessError('unknown_method', call.startsWith('memory.') ? `Unknown memory call ${call}.` : `Unknown Wiki call ${call}.`)
  }
}

function safely<T>(read: () => T): T | null {
  try {
    return read()
  } catch {
    return null
  }
}
