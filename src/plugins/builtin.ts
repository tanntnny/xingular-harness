// The harness's own parts, described as plugins. Each is a description of code that already
// exists; none of it is loaded through Pi's extension system.
import { CONNECTION_TOOLS, NATIVE_GROUP } from '../prompt/compile'
import { ASK_USER } from '../tools/askUser'
import { PLUGIN_PROPOSE } from '../tools/pluginPropose'
import { MEMORY_TOOLS, RECALL_TOOLS, WIKI_TOOLS, type WikiToolDefinition } from '../tools/definitions'
import { FIRST_PARTY_PLUGINS } from './firstParty'
import type { PluginDescriptor } from './types'

const tools = (definitions: readonly WikiToolDefinition[]): PluginDescriptor['tools'] => definitions.map((tool) => ({ name: tool.name, description: tool.label }))

/** Pi itself. Its command's built-in extensions are added to it as they are found. */
export const PI_PLUGIN: PluginDescriptor = {
  id: 'pi',
  title: 'Pi',
  description: 'The engine every session runs on: its base prompt, its file and shell tools, and the extensions built into its command.',
  required: 'Pi runs every session.',
  tools: NATIVE_GROUP.map((name) => ({ name })),
  toolGroups: ['Native']
}

/** A person's own registry. It owns the rules and skills sections even while it is empty. */
export const YOURS_PLUGIN: PluginDescriptor = {
  id: 'yours',
  title: 'Yours',
  description: 'Rules, skills and prompts you wrote, kept as files in the registry folder.',
  manage: 'registry',
  sections: [
    { id: 'rules', name: 'Rules', description: 'The full text of every rule that is on.' },
    { id: 'skills', name: 'Skills list', description: 'One line for each skill that is on.' }
  ],
  tools: WIKI_TOOLS.filter((tool) => tool.name === 'skill_load').map((tool) => ({ name: tool.name, description: tool.label }))
}

export const INCLUDED_PLUGIN: PluginDescriptor = { id: 'included', title: 'Included', description: 'Rules, skills and prompts that ship with the app.', manage: 'registry' }

export const HARNESS_PLUGINS: readonly PluginDescriptor[] = [
  PI_PLUGIN,
  {
    id: 'memory',
    title: 'Memory',
    description: 'Blocks of text that are always in context and that the agent edits as it works.',
    required: 'Every agent keeps its own memory, and the background upkeep depends on it.',
    // Facts are memory too: what the agent wrote down, recalled on request.
    tools: tools([...MEMORY_TOOLS, ...WIKI_TOOLS.filter((tool) => tool.name === 'memory_facts')]),
    sections: [{ id: 'blocks', name: 'Memory blocks', description: 'Every block attached to the caller, in full.' }],
    toolGroups: ['Memory']
  },
  {
    id: 'wiki',
    title: 'Wiki',
    description: 'Pages and facts the agent searches, reads, and proposes changes to.',
    required: 'What was learned is recorded and checked here.',
    // `WIKI_TOOLS` is every memory tool; the Wiki's own are the ones that are not Memory's or History's.
    tools: tools(WIKI_TOOLS.filter((tool) => tool.name.startsWith('wiki_'))),
    sections: [
      { id: 'knowledge', name: 'Knowledge map', description: 'Project pages, the Library count, and facts that match the request.' },
      { id: 'references', name: 'Selected references', description: 'Pages and skills pinned to one request.' }
    ],
    toolGroups: ['Knowledge']
  },
  { id: 'history', title: 'History', description: 'Search over earlier conversations and runs.', required: 'Earlier runs are how an agent picks up where work stopped.', tools: tools(RECALL_TOOLS) },
  {
    id: 'plugin-proposals',
    title: 'Plugin proposals',
    description: 'Lets an agent propose a plugin. You accept it in the Inbox, switch it on, and trust its code; an agent can do none of those.',
    required: 'It only proposes. Nothing is saved or run until you decide.',
    tools: [{ name: PLUGIN_PROPOSE, description: 'Propose a plugin' }]
  },
  { id: 'ask-user', title: 'Ask the user', description: 'Lets the agent stop and ask a question with choices.', required: 'An agent must be able to stop and ask you.', tools: [{ name: ASK_USER }] },
  {
    id: 'connected-apps',
    title: 'Connected apps',
    description: 'Outside services reached over MCP, behind two tools that list and call what is connected.',
    required: 'Connected apps are reached only through it. Each app is switched on its own.',
    manage: 'connections',
    tools: CONNECTION_TOOLS.map((name) => ({ name })),
    toolGroups: ['Connections']
  },
  YOURS_PLUGIN,
  ...FIRST_PARTY_PLUGINS
]
