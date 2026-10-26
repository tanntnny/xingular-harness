import type { AgentProfile } from './profiles'

export const PLAN_RESEARCH_TOOLS: ReadonlySet<string> = new Set([
  'read', 'grep', 'find', 'ls', 'checklist_write', 'session_name',
  'history_search', 'history_read', 'trajectory_search', 'trajectory_read',
  'wiki_entrypoint', 'wiki_search', 'wiki_read', 'wiki_list', 'memory_facts', 'skill_load',
  'web_search', 'web_fetch'
])

export const PLAN_RESEARCH_PLUGINS: readonly string[] = ['history', 'variant', 'web', 'wiki']

export const PLAN_RESEARCH_EVIDENCE_TOOLS: ReadonlySet<string> = new Set([
  'read', 'grep', 'find', 'ls', 'history_search', 'trajectory_search', 'wiki_search', 'web_search', 'web_fetch'
])

export function planResearchProfile(profile: Pick<AgentProfile, 'tools' | 'plugins'> | null | undefined): boolean {
  return Boolean(
    profile
    && Array.isArray(profile.tools)
    && profile.tools.length > 0
    && profile.tools.some(name => PLAN_RESEARCH_EVIDENCE_TOOLS.has(name))
    && profile.tools.every(name => PLAN_RESEARCH_TOOLS.has(name))
    && Array.isArray(profile.plugins)
    && profile.plugins.every(name => PLAN_RESEARCH_PLUGINS.includes(name))
  )
}
