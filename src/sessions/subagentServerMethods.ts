import { invalid, notFound } from '../core/errors'
import { createProfile, listProfiles, removeProfile, resolveProfile, type ProfileScope } from '../agents/profiles'
import type { Harness } from '../harness'
import type { Handler } from '../server/rpc'
import type { SubagentInput, SubagentSelection } from './subagents'

function cwdOf(params: Record<string, unknown> | undefined): string | null {
  const cwd = params?.cwd
  if (cwd === undefined || cwd === null) return null
  if (typeof cwd !== 'string' || !cwd.trim()) throw invalid('cwd must be a folder path.')
  return cwd
}

function nameOf(params: Record<string, unknown> | undefined): string {
  if (typeof params?.name !== 'string' || !params.name.trim()) throw invalid('name is required.')
  return params.name.trim()
}

export function subagentServerMethods(harness: Harness): Record<string, Handler> {
  const root = () => harness.env.root
  return {
    'subagents.spawn': (params) => harness.subagents.spawn(params as SubagentInput),
    'subagents.wait': (params) => harness.subagents.wait(params as SubagentSelection),
    'subagents.results': (params) => harness.subagents.results(params as SubagentSelection),
    // Agent profiles (PROP-0029). The harness is the only writer of profile files.
    'agents.list': (params) => listProfiles(root(), cwdOf(params as Record<string, unknown>)),
    'agents.get': (params) => {
      const p = params as Record<string, unknown>
      const profile = resolveProfile(root(), cwdOf(p), nameOf(p))
      if (!profile) throw notFound(`The profile ${nameOf(p)}`)
      return profile
    },
    'agents.create': (params) => {
      const p = params as Record<string, unknown>
      return createProfile(root(), cwdOf(p), { name: nameOf(p), scope: p.scope as ProfileScope, from: typeof p.from === 'string' ? p.from : null })
    },
    'agents.remove': (params) => {
      const p = params as Record<string, unknown>
      removeProfile(root(), cwdOf(p), { name: nameOf(p), scope: p.scope as ProfileScope })
      return {}
    }
  }
}
