// The harness's own parts, described as plugins. Each is a description of code that already
// exists; none of it is loaded through Pi's extension system.
import { CONNECTION_TOOLS, NATIVE_GROUP } from '../prompt/compile'
import { ASK_USER } from '../tools/askUser'
import { CHECKLIST_WRITE } from '../tools/checklist'
import { SPAWN_SUBAGENT, WAIT_SUBAGENTS } from '../sessions/subagents'
import { RECALL_TOOLS, SKILL_TOOLS, TRAJECTORY_TOOLS, WIKI_READ_TOOLS, WIKI_WRITE_TOOLS, type HarnessToolDefinition } from '../tools/definitions'
import { FIRST_PARTY_PLUGINS } from './firstParty'
import type { PluginDescriptor } from './types'

const tools = (definitions: readonly HarnessToolDefinition[]): PluginDescriptor['tools'] => definitions.map((tool) => ({ name: tool.name, description: tool.label }))

/** Pi itself. Its command's built-in extensions are added to it as they are found. */
export const PI_PLUGIN: PluginDescriptor = {
  id: 'pi',
  title: 'Pi',
  description: 'The engine every session runs on: its base prompt, its file and shell tools, and the extensions built into its command.',
  required: 'Pi runs every session.',
  tools: NATIVE_GROUP.map((name) => ({ name })),
  toolGroups: ['Native']
}

/** The harness tree: the eight components that shape what an agent is told and can do. */
export const HARNESS_TREE_PLUGIN: PluginDescriptor = {
  id: 'harness',
  title: 'Harness',
  description: 'The agent\'s own harness: system prompt, guardrails, memory and tool guidance in every prompt; skills, scripts and subagents on demand; plugins in the tool loop. Versioned, and refined from evidence.',
  required: 'Every agent runs on its harness.',
  sections: [
    { id: 'system', name: 'System prompt', description: 'c1: role and procedure.' },
    { id: 'guardrails', name: 'Guardrails', description: 'c2: standing rules.' },
    { id: 'memory', name: 'Memory', description: 'c3: durable facts about this kind of work.' },
    { id: 'subagents', name: 'Subagents', description: 'c5: the list of this harness\'s subagents.' },
    { id: 'scripts', name: 'Scripts', description: 'c7: where this harness\'s scripts are.' },
    { id: 'reporting', name: 'Reporting', description: 'Fixed harness text, not part of the tree: how the final reply is shaped.' }
  ],
  tools: tools(SKILL_TOOLS)
}

export const HARNESS_PLUGINS: readonly PluginDescriptor[] = [
  PI_PLUGIN,
  { id: 'subagents', title: 'Subagents', description: 'Isolated child runs of the same caller, bounded by parent capabilities and nesting depth.', required: 'Availability is selected by the session host; child runs retain the parent permission boundary.', tools: [{ name: SPAWN_SUBAGENT, description: 'Start a subagent' }, { name: WAIT_SUBAGENTS, description: 'Wait for subagents' }] },
  HARNESS_TREE_PLUGIN,
  {
    id: 'wiki',
    title: 'Wiki',
    description: 'Notes about projects, linked to each other, that agents search and read.',
    required: 'Project notes are reached through it.',
    tools: tools([...WIKI_READ_TOOLS, ...WIKI_WRITE_TOOLS]),
    sections: [
      { id: 'wiki', name: 'Wiki', description: 'The current project\'s notes.' },
      { id: 'references', name: 'Selected references', description: 'Notes pinned to one request.' }
    ],
    toolGroups: ['Wiki']
  },
  { id: 'history', title: 'History', description: 'Search earlier conversations and inspect recorded run trajectories.', required: 'Earlier runs are how an agent picks up where work stopped.', tools: tools([...RECALL_TOOLS, ...TRAJECTORY_TOOLS]), toolGroups: ['History'] },
  { id: 'ask-user', title: 'Ask the user', description: 'Lets the agent stop and ask a question with choices.', required: 'An agent must be able to stop and ask you.', tools: [{ name: ASK_USER }] },
  { id: 'checklist', title: 'Checklist', description: 'Lets the agent keep a checklist of the steps of its work, recorded with the run so progress can be shown and picked up again.', required: 'Progress of longer work is kept through it.', tools: [{ name: CHECKLIST_WRITE, description: 'Write the checklist' }] },
  {
    id: 'connected-apps',
    title: 'Connected apps',
    description: 'Outside services reached over MCP, behind two tools that list and call what is connected.',
    required: 'Connected apps are reached only through it. Each app is switched on its own.',
    manage: 'connections',
    tools: CONNECTION_TOOLS.map((name) => ({ name })),
    toolGroups: ['Connections']
  },
  ...FIRST_PARTY_PLUGINS
]
