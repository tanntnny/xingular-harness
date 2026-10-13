// Proposing a plugin: how an agent offers a person a new skill, instruction, or piece of code
// that extends memory, the Wiki or history. It only proposes. A person accepts it, switches it
// on and trusts its code; no tool does any of those for them.
import { actorOf, type CallerContext } from '../memory/caller'
import type { DispatchEnv } from '../memory/dispatch'
import * as store from '../memory/store'
import { EXTENDABLE, parkPluginProposal } from '../plugins/proposal'
import type { ToolSpec } from './types'

export const PLUGIN_PROPOSE = 'plugin_propose'

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export function pluginProposeTool(env: DispatchEnv, caller: CallerContext): ToolSpec {
  return {
    name: PLUGIN_PROPOSE,
    label: 'Propose a plugin',
    description:
      'Propose a plugin for the user to review: a bundle of files that changes how agents work. Nothing is saved until the user accepts it, and its code never runs until they also switch it on and trust it. ' +
      'Files by folder: skills/<name>/SKILL.md (a procedure, with name and description front matter), prompts/<name>.md (a slash command), extensions/<name>.ts (a Pi extension), ' +
      'and hooks.mjs for code the harness runs after a change: `export default function (harness) { harness.on("memory.saved", async (event, ctx) => { await ctx.call("<connected app name>", "<tool>", { text: event.body }) }) }`. ' +
      'Hook events: memory.saved, memory.block.changed, wiki.page.saved (each has id, title, body, actor) and history.run.ended (runId, status, goal). ' +
      'ctx.call reaches only a connected-app tool the user marked to run without asking; put no key or password in a file. Do not include package.json.',
    parameters: (Type) =>
      Type.Object({
        name: Type.String({ description: 'A short name, such as memory-to-docs' }),
        description: Type.String({ description: 'One line the user reads first: what it does' }),
        extends: Type.Optional(Type.Array(Type.String({ description: `One of ${EXTENDABLE.join(', ')}` }))),
        reason: Type.Optional(Type.String({ description: 'Why you are proposing it' })),
        files: Type.Array(Type.Object({ path: Type.String({ description: 'A path inside the plugin, such as hooks.mjs' }), content: Type.String() }), { maxItems: 40 })
      }),
    execute: async (input) => {
      const files = (Array.isArray(input.files) ? input.files : []).map((file) => ({ path: text((file as { path?: unknown }).path), content: text((file as { content?: unknown }).content) }))
      const extended = (Array.isArray(input.extends) ? input.extends : []).filter((part): part is string => typeof part === 'string')
      const from = caller.agentName ? `${caller.agentName} (${actorOf(caller)})` : actorOf(caller)
      const slug = parkPluginProposal(store.wikiDir(env.root), from, { name: text(input.name), description: text(input.description), extends: extended, reason: text(input.reason), files })
      env.bus?.emit({ type: 'wiki.changed' })
      return `The plugin "${slug}" is waiting in the Inbox. It is saved only if the user accepts it, and it does nothing until they switch it on${files.some((file) => file.path.startsWith('extensions/') || /^hooks\.m?js$/.test(file.path)) ? ' and trust its code' : ''}.`
    }
  }
}
