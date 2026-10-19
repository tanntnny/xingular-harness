// The editable surface of a harness: the eight components a person or an improver may change,
// where each lives in the tree, and the rules that keep a tree loadable by Pi.
//
// Ported from Harness² (Apache-2.0, Google LLC; `harness2/core/tree.py`, `SurfaceSpec`). The
// component numbering c1..c8 follows the paper: system prompt, guardrails, memory, tool
// guidance, subagents, skills, scripts and plugins.

/** A harness: relative path → file text, for every file on the editable surface. */
export type Tree = Record<string, string>

export type ComponentId = 'systemPrompt' | 'guardrails' | 'memory' | 'toolGuidance' | 'subagents' | 'skills' | 'scripts' | 'plugins'

/** How a component reaches a run, grouped as the paper groups them. */
export type ComponentGroup = 'context' | 'toolInterface' | 'orchestration' | 'middleware'

export interface ComponentInfo {
  id: ComponentId
  /** c1..c8, as numbered in the paper. */
  index: number
  title: string
  group: ComponentGroup
  /** Where it lives: a file for an always-on component, a pattern for the others. */
  path: string
  /** When it is in a run's context. */
  reach: 'always' | 'onDemand' | 'ownContext' | 'toolLoop'
  description: string
}

export interface SurfaceSpec {
  name: string
  /** Files whose whole text is in every run's prompt. */
  alwaysOn: readonly string[]
  /** The most always-on characters a tree may carry. */
  alwaysOnMax: number
  alwaysOnCapReason: string
  skillDir: string
  /** Pi drops a skill whose frontmatter `name` differs from its folder. */
  skillNameRule: 'must_match' | 'overrides_dir'
  triggerHint: string
  autotriggerFile: string
  triggerLine: string
  subagentDir: string
  scriptDir: string
  /** Script file extensions the surface accepts. */
  scriptExtensions: readonly string[]
  pluginDir: string
  /** Short README files written beside each directory so an editor knows the form. */
  stubs: readonly (readonly [string, string])[]
  components: readonly ComponentInfo[]
}

export const SYSTEM_PROMPT = 'systemprompt.md'
export const GUARDRAILS = 'guardrails.md'
export const MEMORY = 'memory.md'
export const TOOL_GUIDANCE = 'tool_guidance.md'

/** The Pi surface: the one surface this harness runs. */
export const PI_SURFACE: SurfaceSpec = {
  name: 'pi',
  alwaysOn: [SYSTEM_PROMPT, GUARDRAILS, MEMORY, TOOL_GUIDANCE],
  alwaysOnMax: 24_000,
  alwaysOnCapReason: 'every token here competes with the agent\'s own output budget on every run',
  skillDir: 'skills',
  skillNameRule: 'must_match',
  triggerHint: 'Fix it by adding a trigger line naming `{name}` to systemprompt.md or guardrails.md, e.g. "When <the situation this skill handles>, load the `{name}` skill."',
  autotriggerFile: GUARDRAILS,
  triggerLine: '- When {desc}, load the `{name}` skill.',
  subagentDir: 'sub_agents',
  scriptDir: 'scripts',
  scriptExtensions: ['.py', '.mjs'],
  pluginDir: 'plugins',
  stubs: [
    ['scripts/README.md', '<!-- c7: deterministic helpers. Add one as scripts/<name>.py or scripts/<name>.mjs; the prompt names the folder they are staged in. -->\n'],
    ['sub_agents/README.md', '<!-- c5: delegated subagents, started with `spawn_subagent` and `agent: "<name>"`, each in its OWN context. Add one as sub_agents/<name>/AGENT.md with a `description:` in its frontmatter. -->\n'],
    ['plugins/README.md', '<!-- c8: Pi extensions. They act INSIDE the tool loop -- the only lever that can enforce something the model cannot skip. Add one as plugins/<name>.ts with a default export. New or changed code waits for the person to trust it. -->\n'],
    ['skills/README.md', '<!-- c6: reusable workflows loaded on demand. Add one as skills/<name>/SKILL.md with frontmatter `name:` matching the folder and a `description:`. -->\n']
  ],
  components: [
    { id: 'systemPrompt', index: 1, title: 'System prompt', group: 'context', path: SYSTEM_PROMPT, reach: 'always', description: 'Role and procedure.' },
    { id: 'guardrails', index: 2, title: 'Guardrails', group: 'context', path: GUARDRAILS, reach: 'always', description: 'Standing rules the agent keeps on every run.' },
    { id: 'memory', index: 3, title: 'Memory', group: 'context', path: MEMORY, reach: 'always', description: 'Durable, general facts about this kind of work.' },
    { id: 'toolGuidance', index: 4, title: 'Tool guidance', group: 'toolInterface', path: TOOL_GUIDANCE, reach: 'always', description: 'How to use the tools well.' },
    { id: 'subagents', index: 5, title: 'Subagents', group: 'orchestration', path: 'sub_agents/<name>/AGENT.md', reach: 'ownContext', description: 'Bounded helpers that run in their own context and return text.' },
    { id: 'skills', index: 6, title: 'Skills', group: 'context', path: 'skills/<name>/SKILL.md', reach: 'onDemand', description: 'Reusable workflows loaded when a situation matches.' },
    { id: 'scripts', index: 7, title: 'Scripts', group: 'toolInterface', path: 'scripts/<name>.py', reach: 'onDemand', description: 'Deterministic helpers the agent runs.' },
    { id: 'plugins', index: 8, title: 'Plugins', group: 'middleware', path: 'plugins/<name>.ts', reach: 'toolLoop', description: 'Pi extensions that act inside the tool loop.' }
  ]
}

const NAME = '[a-z0-9][a-z0-9_\\-]*'

export interface SurfacePatterns {
  skill: RegExp
  skillScript: RegExp
  subagent: RegExp
  script: RegExp
  scriptRef: RegExp
  plugin: RegExp
}

const cache = new Map<string, SurfacePatterns>()

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function patterns(surface: SurfaceSpec): SurfacePatterns {
  const known = cache.get(surface.name)
  if (known) return known
  const skills = escape(surface.skillDir)
  const scripts = escape(surface.scriptDir)
  const extensions = surface.scriptExtensions.map((extension) => escape(extension.slice(1))).join('|')
  const made: SurfacePatterns = {
    skill: new RegExp(`^${skills}/(${NAME})/SKILL\\.md$`),
    skillScript: new RegExp(`^${skills}/${NAME}/scripts/[A-Za-z0-9_.\\-]+$`),
    subagent: new RegExp(`^${escape(surface.subagentDir)}/(${NAME})/AGENT\\.md$`),
    script: new RegExp(`^${scripts}/[a-z0-9_][a-z0-9_]*\\.(?:${extensions})$`),
    scriptRef: new RegExp(`(?:python3?|node)\\s+((?:${skills}/[\\w\\-]+/)?${scripts}/[\\w.\\-]+\\.(?:${extensions}))`, 'g'),
    plugin: new RegExp(`^${escape(surface.pluginDir)}/(${NAME})\\.ts$`)
  }
  cache.set(surface.name, made)
  return made
}

/** Which component a path belongs to, or null when it is off the surface. */
export function componentOf(surface: SurfaceSpec, rel: string): ComponentId | null {
  const found = surface.components.find((component) => component.path === rel)
  if (found) return found.id
  const r = patterns(surface)
  if (r.skill.test(rel) || r.skillScript.test(rel)) return 'skills'
  if (r.subagent.test(rel)) return 'subagents'
  if (r.script.test(rel)) return 'scripts'
  if (r.plugin.test(rel)) return 'plugins'
  return null
}
