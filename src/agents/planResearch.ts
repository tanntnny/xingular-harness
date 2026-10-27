import type { CapabilitySet } from '../capabilities/types'
import { narrowForProfile } from './narrow'
import type { PluginDescriptor } from '../plugins/types'
import type { AgentProfile } from './profiles'

export const PLAN_RESEARCH_TOOLS: ReadonlySet<string> = new Set([
  'read', 'grep', 'find', 'ls', 'todo_write', 'session_name',
  'history_search', 'history_read', 'trajectory_search', 'trajectory_read',
  'wiki_entrypoint', 'wiki_search', 'wiki_read', 'wiki_list', 'memory_facts', 'skill_load',
  'web_search', 'web_fetch'
])

export const PLAN_RESEARCH_PLUGINS: readonly string[] = ['history', 'variant', 'web', 'wiki']

export const PLAN_RESEARCH_EVIDENCE_TOOLS: ReadonlySet<string> = new Set([
  'read', 'grep', 'find', 'ls', 'history_search', 'trajectory_search', 'wiki_search', 'web_search', 'web_fetch'
])

/** Capability snapshot needed to tell whether a profile can research in this particular run. */
export interface PlanResearchContext {
  frozenTools: readonly string[]
  contributions: readonly string[]
  descriptors: readonly PluginDescriptor[]
}

export interface PlanResearchEligibility {
  eligible: boolean
  refusal: string | null
  /** The exact safe child snapshot to launch when eligible. */
  capabilities: CapabilitySet
  unavailableTools: string[]
}

function profileRefusal(profile: Pick<AgentProfile, 'name' | 'tools' | 'plugins'> | null | undefined): string | null {
  if (!profile) return 'Plan-mode delegation requires a named, eligible read-only research profile.'
  if (!Array.isArray(profile.tools) || profile.tools.length === 0) {
    return `Profile ${profile.name} must declare an explicit tools allowlist for plan-mode research.`
  }
  const unsafeTools = profile.tools.filter(name => !PLAN_RESEARCH_TOOLS.has(name))
  if (unsafeTools.length) {
    return `Profile ${profile.name} includes non-research tools: ${[...new Set(unsafeTools)].join(', ')}. Use a profile whose tools are all plan research tools.`
  }
  if (!profile.tools.some(name => PLAN_RESEARCH_EVIDENCE_TOOLS.has(name))) {
    return `Profile ${profile.name} must allow at least one read-only research evidence tool.`
  }
  if (!Array.isArray(profile.plugins)) {
    return `Profile ${profile.name} must declare an explicit plugin allowlist for plan-mode research.`
  }
  const unsafePlugins = profile.plugins.filter(name => !PLAN_RESEARCH_PLUGINS.includes(name))
  if (unsafePlugins.length) {
    return `Profile ${profile.name} includes non-research plugins: ${[...new Set(unsafePlugins)].join(', ')}. Use only the plan research plugins: ${PLAN_RESEARCH_PLUGINS.join(', ')}.`
  }
  return null
}

/** Whether the profile's explicit allowlists are restricted to read-only research. */
export function planResearchProfile(profile: Pick<AgentProfile, 'name' | 'tools' | 'plugins'> | null | undefined): boolean {
  return profileRefusal(profile) === null
}

/**
 * Evaluate the same effective intersection used for launch, including tool ownership removed by
 * profile plugin narrowing. An explicit request is a strict override; omission inherits the safe
 * profile/parent intersection.
 */
export function planResearchEligibility(
  profile: Pick<AgentProfile, 'name' | 'tools' | 'plugins'> | null | undefined,
  context: PlanResearchContext,
  requested?: readonly string[]
): PlanResearchEligibility {
  const empty: CapabilitySet = { version: 1, tools: [], connectors: [], contributions: [] }
  const profileProblem = profileRefusal(profile)
  if (profileProblem) return { eligible: false, refusal: profileProblem, capabilities: empty, unavailableTools: [] }

  const parent: CapabilitySet = {
    version: 1,
    tools: [...context.frozenTools],
    connectors: [],
    contributions: [...context.contributions]
  }
  const narrowed = narrowForProfile(parent, profile!, requested, context.descriptors)
  const capabilities: CapabilitySet = {
    ...narrowed.capabilities,
    tools: narrowed.capabilities.tools.filter(name => PLAN_RESEARCH_TOOLS.has(name)),
    connectors: []
  }

  if (requested) {
    const effective = new Set(capabilities.tools)
    const incompatible = [...new Set(requested.filter(name =>
      !PLAN_RESEARCH_TOOLS.has(name)
      || !profile!.tools!.includes(name)
      || !context.frozenTools.includes(name)
      || !effective.has(name)
    ))]
    if (incompatible.length) {
      return {
        eligible: false,
        refusal: `Plan-mode tools override contains incompatible tool(s): ${incompatible.join(', ')}. Omit \`tools\` to inherit the selected profile's safe research intersection, or retry with only tools allowed by that profile, available in this parent run, and in the plan research set.`,
        capabilities,
        unavailableTools: narrowed.unavailable
      }
    }
  }

  if (!capabilities.tools.some(name => PLAN_RESEARCH_EVIDENCE_TOOLS.has(name))) {
    const refusal = requested
      ? `The tools override [${requested.join(', ')}] leaves no available research evidence tool for profile ${profile!.name}. Omit \`tools\` to inherit the safe intersection, or retry with an available evidence tool from this profile.`
      : `Profile ${profile!.name} has no read-only research evidence tool after intersecting its allowlists with this run's frozen capabilities and plugin contributions. Choose a profile with an available evidence tool.`
    return { eligible: false, refusal, capabilities, unavailableTools: narrowed.unavailable }
  }

  return { eligible: true, refusal: null, capabilities, unavailableTools: narrowed.unavailable }
}
