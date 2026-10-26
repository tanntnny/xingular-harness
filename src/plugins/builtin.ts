// Built-in feature modules register their contributions here; this registry never loads Pi code.
import { CONNECTION_TOOLS, NATIVE_GROUP } from '../prompt/compile'
import { ASK_USER, askUserTool } from '../tools/askUser'
import { CHECKLIST_WRITE, checklistTool } from '../tools/checklist'
import { CHECKPOINT_WRITE, checkpointTool } from '../tools/checkpoint'
import { sliceOf } from '../sessions/workSlice'
import { SPAWN_SUBAGENT, WAIT_SUBAGENTS } from '../sessions/subagents'
import { subagentTools } from '../tools/spawnSubagent'
import { SESSION_NAME } from '../tools/sessionName'
import { RECALL_TOOLS, SKILL_TOOLS, TRAJECTORY_TOOLS, WIKI_READ_TOOLS, WIKI_WRITE_TOOLS, type HarnessToolDefinition } from '../tools/definitions'
import { FIRST_PARTY_PLUGINS } from './firstParty'
import { WEB_PLUGIN } from '../web/tools'
import { KEYLESS_SEARCH, webPart } from '../web/part'
import { BROWSER_PLUGIN, browserPluginPart } from '../browser/index'
import { ANNOTATIONS_PLUGIN } from '../annotations/part'
import { annotationsPart } from '../annotations/part'
import { webServerMethods } from '../web/serverMethods'
import { browserServerMethods } from '../browser/serverMethods'
import { annotationServerMethods } from '../annotations/serverMethods'
import { doctorServerMethods } from '../doctor/serverMethods'
import { worktreeServerMethods } from '../worktrees/serverMethods'
import { hubServerMethods } from '../hub/serverMethods'
import { refinementServerMethods } from '../refine/serverMethods'
import { wikiServerMethods } from '../wiki/serverMethods'
import { historyServerMethods } from '../history/serverMethods'
import { subagentServerMethods } from '../sessions/subagentServerMethods'
import { sideQuestionServerMethods } from '../sessions/sideQuestionServerMethods'
import { connectedAppServerMethods } from '../mcp/serverMethods'
import { harnessTools } from '../tools/harnessTools'
import { GET_CAPABILITIES } from '../tools/getCapabilities'
import { USAGE_SETTINGS } from '../usage/settings'
import { usageServerMethods } from '../usage/serverMethods'
import type { PluginDescriptor } from './types'
import { createBuiltinPluginRegistry } from './builtinRegistry'

const tools = (definitions: readonly HarnessToolDefinition[]): PluginDescriptor['tools'] => definitions.map((tool) => ({ name: tool.name, description: tool.label }))
const toolContribution = (definitions: readonly HarnessToolDefinition[], toolOrder: number) => ({
  toolOrder,
  tools: (context: import('./builtinRegistry').BuiltinToolContext) => context.harnessTools
    ? harnessTools(context.env, context.caller, { variantDir: context.variantDir, definitions })
    : []
})

/** Pi itself. Its command's built-in extensions are added to it as they are found. */
export const PI_PLUGIN: PluginDescriptor = {
  id: 'pi',
  title: 'Pi',
  description: 'The engine every session runs on: its base prompt, its file and shell tools, and the extensions built into its command.',
  required: 'Pi runs every session.',
  tools: [...NATIVE_GROUP.map((name) => ({ name })), { name: SESSION_NAME }],
  toolGroups: ['Native']
}

/** The variant: the eight components that shape what an agent is told and can do. */
export const VARIANT_PLUGIN: PluginDescriptor = {
  id: 'variant',
  title: 'Variant',
  description: 'The agent\'s own variant: system prompt, guardrails, memory and tool guidance in every prompt; skills, scripts and subagents on demand; plugins in the tool loop. Versioned, and refined from evidence.',
  required: 'Every agent runs on a variant.',
  sections: [
    { id: 'harness-identity', name: 'Harness identity', description: 'Fixed foundation identity; not part of the variant.' },
    { id: 'system', name: 'System prompt', description: 'c1: role and procedure.' },
    { id: 'guardrails', name: 'Guardrails', description: 'c2: standing rules.' },
    { id: 'memory', name: 'Memory', description: 'c3: durable facts about this kind of work.' },
    { id: 'subagents', name: 'Subagents', description: 'c5: the list of this variant\'s subagents.' },
    { id: 'scripts', name: 'Scripts', description: 'c7: where this variant\'s scripts are.' },
    { id: 'reporting', name: 'Reporting', description: 'Fixed foundation text, not part of the variant: how the final reply is shaped.' }
  ],
  tools: tools(SKILL_TOOLS)
}

const SUBAGENTS_PLUGIN: PluginDescriptor = { id: 'subagents', title: 'Subagents', description: 'Isolated child runs of the same caller, bounded by parent capabilities and nesting depth.', required: 'Availability is selected by the session host; child runs retain the parent permission boundary.', tools: [{ name: SPAWN_SUBAGENT, description: 'Start a subagent' }, { name: WAIT_SUBAGENTS, description: 'Wait for subagents' }] }
const WIKI_PLUGIN: PluginDescriptor = {
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
  }
const HISTORY_PLUGIN: PluginDescriptor = { id: 'history', title: 'History', description: 'Search earlier conversations and inspect recorded run trajectories.', required: 'Earlier runs are how an agent picks up where work stopped.', tools: tools([...RECALL_TOOLS, ...TRAJECTORY_TOOLS]), toolGroups: ['History'] }
const ASK_USER_PLUGIN: PluginDescriptor = { id: 'ask-user', title: 'Ask the user', description: 'Lets the agent stop and ask a question with choices.', required: 'An agent must be able to stop and ask you.', tools: [{ name: ASK_USER }] }
const CHECKLIST_PLUGIN: PluginDescriptor = { id: 'checklist', title: 'Checklist', description: 'Lets the agent keep a checklist of the steps of its work, recorded with the run so progress can be shown and picked up again.', required: 'Progress of longer work is kept through it.', tools: [{ name: CHECKLIST_WRITE, description: 'Write the checklist' }] }
const CHECKPOINT_PLUGIN: PluginDescriptor = { id: 'checkpoint', title: 'Checkpoint', description: 'Lets a bounded reply record a handoff at a work-slice boundary so the next slice starts from it.', required: 'A reply that stops at its budget leaves the state the next one resumes from.', tools: [{ name: CHECKPOINT_WRITE, description: 'Write the handoff checkpoint' }] }
const CONNECTED_APPS_PLUGIN: PluginDescriptor = {
    id: 'connected-apps',
    title: 'Connected apps',
    description: 'Outside services reached over MCP, behind two tools that list and call what is connected.',
    required: 'Connected apps are reached only through it. Each app is switched on its own.',
    manage: 'connections',
    tools: CONNECTION_TOOLS.map((name) => ({ name })),
    toolGroups: ['Connections']
  }
const DOCTOR_PLUGIN: PluginDescriptor = { id: 'doctor', title: 'Doctor', description: 'Local readiness checks and explicitly confirmed live probes for accounts, models and tools.', required: 'Every local terminal has readiness diagnostics.' }
const WORKTREES_PLUGIN: PluginDescriptor = { id: 'worktrees', title: 'Worktrees', description: 'Create and manage isolated git worktrees, move changes between them, and restore removed worktrees.', required: 'Managed worktrees are available to every local terminal.' }
const HUB_PLUGIN: PluginDescriptor = { id: 'hub', title: 'Hub', description: 'Browse and install reviewed skills, plugins and documents from configured registries.', required: 'Reviewed Harness resources are available to every host.' }
const REFINEMENT_PLUGIN: PluginDescriptor = { id: 'refinement', title: 'Refinement', description: 'Improve variants from recorded evidence through isolated refinement runs and reviewed candidates.', required: 'Variant refinement is available to every host.' }
const CAPABILITIES_PLUGIN: PluginDescriptor = { id: 'capabilities', title: 'Capability discovery', description: 'Inspect the callable tools of the current run, including their input schemas. Discovery never grants access.', required: 'Every interactive session can inspect its own registered capabilities.', tools: [{ name: GET_CAPABILITIES, description: 'Inspect current capabilities' }] }
const USAGE_PLUGIN: PluginDescriptor = {
  id: 'usage',
  title: 'Usage',
  description: 'Token, cost and latency totals from recorded runs, and the plan windows, balances or rate limits each provider reports.',
  settings: [...USAGE_SETTINGS]
}

const SIDE_QUESTIONS_PLUGIN: PluginDescriptor = {
  id: 'side-questions',
  title: 'Side questions',
  description: 'Separate, tool-free answers that use a redacted projection of the main conversation.',
  required: 'Every host can ask a side question without steering its main run.',
  sections: [{ id: 'side-question', name: 'Side-question role', description: 'Fixed instructions for an independent, tool-free side run.' }]
}

export const BUILTIN_PLUGIN_REGISTRY = createBuiltinPluginRegistry([
  {
    descriptor: PI_PLUGIN,
    toolOrder: 60,
    tools: context => context.harnessTools ? [context.sessionName] : []
  },
  {
    descriptor: SUBAGENTS_PLUGIN,
    toolOrder: 70,
    tools: context => context.allowedTools.includes(SPAWN_SUBAGENT)
      ? subagentTools(context.subagents, context.runId).filter(tool => context.allowedTools.includes(tool.name))
      : [],
    serverMethods: subagentServerMethods
  },
  { descriptor: VARIANT_PLUGIN, ...toolContribution(SKILL_TOOLS, 30) },
  { descriptor: WIKI_PLUGIN, ...toolContribution([...WIKI_READ_TOOLS, ...WIKI_WRITE_TOOLS], 20), serverMethods: wikiServerMethods },
  {
    descriptor: HISTORY_PLUGIN,
    ...toolContribution([...RECALL_TOOLS, ...TRAJECTORY_TOOLS], 10),
    serverMethods: historyServerMethods
  },
  { descriptor: ASK_USER_PLUGIN, toolOrder: 40, tools: context => context.harnessTools && context.allowedTools.includes(ASK_USER) ? [askUserTool(context.run)] : [] },
  { descriptor: CHECKLIST_PLUGIN, toolOrder: 50, tools: context => context.harnessTools ? [checklistTool(context.run)] : [] },
  { descriptor: CHECKPOINT_PLUGIN, toolOrder: 51, tools: context => context.harnessTools && context.allowedTools.includes(CHECKPOINT_WRITE) ? [checkpointTool(context.run, () => sliceOf(context.env.root, context.runId))] : [] },
  {
    descriptor: CONNECTED_APPS_PLUGIN,
    toolOrder: 0,
    tools: context => context.connectionTools?.() ?? [],
    serverMethods: connectedAppServerMethods
  },
  { descriptor: HUB_PLUGIN, serverMethods: hubServerMethods },
  { descriptor: REFINEMENT_PLUGIN, serverMethods: refinementServerMethods },
  { descriptor: SIDE_QUESTIONS_PLUGIN, serverMethods: sideQuestionServerMethods },
  {
    descriptor: WEB_PLUGIN,
    createWorldPart: ({ options, setting }) => webPart({ secrets: options.secrets, request: options.request, keyless: () => setting(WEB_PLUGIN.id, KEYLESS_SEARCH) === 1 }),
    serverMethods: webServerMethods
  },
  {
    descriptor: BROWSER_PLUGIN,
    createWorldPart: ({ browserEngine }) => browserEngine ? browserPluginPart(browserEngine) : null,
    serverMethods: browserServerMethods
  },
  {
    descriptor: ANNOTATIONS_PLUGIN,
    commandPrefix: 'annotate',
    defaultCommand: 'annotate',
    commands: [
      { name: 'notes', description: 'Review web annotations saved from pages and apps' },
      { name: 'annotate', description: 'Inspect a page or app, comment on components, and send fixes: /annotate:annotate [url | --app <devtools address> | --bridge]' }
    ],
    createWorldPart: ({ options }) => annotationsPart({ root: options.root, changed: options.notesChanged }),
    serverMethods: annotationServerMethods
  },
  { descriptor: CAPABILITIES_PLUGIN },
  {
    descriptor: USAGE_PLUGIN,
    commandPrefix: 'usage',
    defaultCommand: 'analysis',
    commands: [
      { name: 'analysis', description: 'Token, cost and latency totals: /usage:analysis [today | 7d | 30d | all]' },
      { name: 'limit', description: 'Provider plan windows, balances and rate limits: /usage:limit' }
    ],
    serverMethods: usageServerMethods
  },
  { descriptor: DOCTOR_PLUGIN, serverMethods: doctorServerMethods },
  { descriptor: WORKTREES_PLUGIN, serverMethods: worktreeServerMethods },
  ...FIRST_PARTY_PLUGINS.map(descriptor => ({ descriptor }))
])

export const HARNESS_PLUGINS: readonly PluginDescriptor[] = BUILTIN_PLUGIN_REGISTRY.descriptors()
