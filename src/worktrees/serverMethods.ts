import type { Harness } from '../harness'
import type { Handler } from '../server/rpc'
import { invalid } from '../core/errors'
import { optional, text } from '../server/params'

export function worktreeServerMethods(harness: Harness): Record<string, Handler> {
  return {
    'worktrees.list': (params) => harness.worktrees.list(optional(params, 'repo')),
    'worktrees.removed': (params) => harness.worktrees.removed(optional(params, 'repo')),
    'worktrees.status': (params) => harness.worktrees.status(text(params, 'id')),
    'worktrees.create': (params) => harness.worktrees.create({
      repo: text(params, 'repo'),
      ...(optional(params, 'name') ? { name: optional(params, 'name')! } : {}),
      ...(optional(params, 'baseRef') ? { baseRef: optional(params, 'baseRef')! } : {}),
      ...(optional(params, 'branch') ? { branch: optional(params, 'branch')! } : {}),
      ...(params.kind === 'permanent' || params.kind === 'managed' ? { kind: params.kind } : {}),
      ...(typeof params.carryChanges === 'boolean' ? { carryChanges: params.carryChanges } : {}),
      ...(typeof params.setup === 'boolean' ? { setup: params.setup } : {})
    }),
    'worktrees.branch': (params) => harness.worktrees.branch(text(params, 'id'), text(params, 'name')),
    'worktrees.handoff': (params) => {
      const direction = text(params, 'direction')
      if (direction !== 'toSource' && direction !== 'toWorktree') throw invalid('direction is toSource or toWorktree.')
      return harness.worktrees.handoff(text(params, 'id'), direction, { move: params.move !== false })
    },
    'worktrees.remove': (params) => harness.worktrees.remove(text(params, 'id'), { force: params.force === true }),
    'worktrees.restore': (params) => harness.worktrees.restore(text(params, 'id')),
    'worktrees.prune': (params) => harness.worktrees.prune({ repo: optional(params, 'repo'), ...(typeof params.keep === 'number' ? { keep: params.keep } : {}) }),
    'worktrees.adopt': (params) => harness.worktrees.adopt(text(params, 'path')),
    'worktrees.setup.trust': async (params) => { await harness.worktrees.trustSetup(text(params, 'repo'), text(params, 'hash')); return {} }
  }
}
