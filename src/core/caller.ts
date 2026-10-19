// Who a session works as. The embedding application supplies this when a session starts; the
// harness never looks an agent up by itself. The ids are opaque to the harness.
import { findProject, type Project } from './projects'

export interface CallerContext {
  /** Opaque, host-owned policy data frozen when this session starts. The harness only forwards it to the embedding app's tool policy. */
  policyContext?: unknown
  runId?: string | null
  sessionId?: string | null
  projectId?: string | null
  /** The caller: decides which plugins and connectors reach it, and whose history it recalls. */
  agentId?: string | null
  /** Callers whose conversations this one may not recall (opaque ids from the embedding host). */
  recallExcludeAgents?: string[] | null
  /** The caller's name, recorded on what it writes. */
  agentName?: string | null
  /** `Chat` for an agent's own conversation, `Code` for a session in a project. */
  actor?: string | null
  /** `cli` when the caller reaches the harness through a terminal command. */
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
