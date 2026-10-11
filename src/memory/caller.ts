// Who is calling the memory and Wiki API. The embedding application supplies this when a
// session starts; the harness never looks an agent up by itself.
import { findProject, projectsOrNone, type Project } from '../core/projects'
import { invalid } from '../core/errors'
import type { HarnessEnv } from '../core/env'
import * as blocks from './blocks'

/**
 * The current project only orders results and picks a default namespace for proposals; it
 * never limits what can be read.
 */
export interface CallerContext {
  runId?: string | null
  sessionId?: string | null
  projectId?: string | null
  /** The agent calling; it decides which memory blocks are attached and editable. */
  agentId?: string | null
  /** The agent's name, recorded on the revisions it makes. */
  agentName?: string | null
  /** Projects whose briefs the agent carries, most recently active first. */
  briefProjectIds?: string[] | null
  /** `Chat` for an agent's own conversation, `Code` for a session in a project. */
  actor?: string | null
  /** `cli` when the caller reaches the Wiki through the `agentx-wiki` command. */
  surface?: string | null
}

export const isSession = (context: CallerContext): boolean => context.actor === 'Code'
export const actorOf = (context: CallerContext): string => (isSession(context) ? 'Code' : 'Chat')
export const usesCli = (context: CallerContext): boolean => context.surface === 'cli'

export function projectOf(root: string, context: CallerContext): Project | null {
  if (!context.projectId) return null
  try {
    return findProject(root, context.projectId)
  } catch {
    return null
  }
}

/** Who is asking, for block attachment and permissions: an agent, or a session. */
export function blockCaller(env: HarnessEnv, context: CallerContext): blocks.Caller {
  if (isSession(context)) return { kind: 'session', projectSlug: projectOf(env.root, context)?.slug ?? null }
  if (!context.agentId) throw invalid('Memory blocks need an agent or a Harness session.')
  return { kind: 'agent', id: context.agentId, name: context.agentName ?? env.directory.agentName(context.agentId) ?? context.agentId }
}

/** The blocks in the caller's context: an agent also carries the briefs of its active projects. */
export function callerBlocks(env: HarnessEnv, context: CallerContext): { caller: blocks.Caller; attached: blocks.Block[] } {
  const caller = blockCaller(env, context)
  let slugs: string[] = []
  if (caller.kind === 'agent' && context.briefProjectIds?.length) {
    const projects = projectsOrNone(env.root)
    slugs = context.briefProjectIds.flatMap((id) => projects.find((project) => project.id === id)?.slug ?? [])
  }
  return { caller, attached: blocks.attached(env.root, caller, slugs) }
}
