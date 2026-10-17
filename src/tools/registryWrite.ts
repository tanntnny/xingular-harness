// Writing skills, rules, prompts and plugins directly, for the agent that wrote them. Nothing
// goes through the Inbox first, but every write is recorded there, and a plugin's code runs only
// once it is trusted. A change that would alter an item other people already use goes to the
// Inbox instead, as before.
import { join, resolve } from 'node:path'

import { invalid } from '../core/errors'
import type { Harness } from '../harness'
import { actorOf, type CallerContext } from '../memory/caller'
import { enqueueCuration } from '../memory/curation'
import { inbox } from '../memory/operations'
import { parkRegistryProposal } from '../memory/proposals'
import { looksSecret } from '../memory/secrets'
import * as store from '../memory/store'
import { reindexQuietly } from '../memory/wikiIndex'
import { attach, ensureAdopted, loadingFor, trust } from '../plugins/api'
import * as attachments from '../plugins/attachments'
import type { PluginDescriptor } from '../plugins/types'
import { acceptPluginProposal, checkPluginProposal } from '../plugins/proposal'
import * as registry from '../skills/registry'
import type { ToolProvider, ToolSpec } from './types'

export const REGISTRY_WRITE = 'registry_write'
export const PLUGIN_WRITE = 'plugin_write'

const MAX_BODY_BYTES = 64 * 1024
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The tools as a plugin, for an application that provides them. */
export const REGISTRY_WRITE_PLUGIN: PluginDescriptor = {
  id: 'registry-write',
  title: 'Skills and plugins',
  description: 'Lets an agent write a skill, rule, prompt or plugin directly. A new item is on only for the agent that wrote it. A plugin is switched on for that agent and its code is trusted only after it is written; an item already in use by others goes to the Inbox.',
  manage: 'tools',
  tools: [
    { name: REGISTRY_WRITE, description: 'Write a skill, rule or prompt' },
    { name: PLUGIN_WRITE, description: 'Write a plugin' }
  ]
}

export interface RegistryToolOptions {
  harness: Harness
}

/** The `registry_write` and `plugin_write` tools. Only the names a session allows are registered. */
export function registryTools(options: RegistryToolOptions): ToolProvider {
  return ({ caller }) => [registryWriteTool(options.harness, caller), pluginWriteTool(options.harness, caller)]
}

function actorLabel(caller: CallerContext): string {
  return caller.agentName ? `${caller.agentName} (${actorOf(caller)})` : actorOf(caller)
}

function requireAgent(caller: CallerContext): string {
  if (!caller.agentId) throw invalid('Only an agent can write skills, rules, prompts, or plugins.')
  return caller.agentId
}

/**
 * Whether an existing item belongs to this agent alone: switched on for no one else, nowhere
 * wider, and not built in. Anything else is someone else's to review.
 */
function ownedByCaller(choices: attachments.Attachments, id: string, agentId: string, builtin: boolean): boolean {
  const where = attachments.describe(choices, id, builtin)
  if (where.global || where.on.projectIds.length) return false
  return where.on.agentIds.length === 1 && where.on.agentIds[0] === agentId
}

function registryWriteTool(harness: Harness, caller: CallerContext): ToolSpec {
  return {
    name: REGISTRY_WRITE,
    label: caller.vaultAccess ? 'Propose a skill, rule or prompt' : 'Write a skill, rule or prompt',
    description: caller.vaultAccess ? 'Submit a bounded text skill, rule or prompt for curator review. It stays inactive until reviewed; permissions and code trust remain unchanged.' :
      'Write a skill, rule or prompt directly. It is on only for you until the user switches it on for others. ' +
      'An item that others already use, or that is built in, is not changed: your text goes to the Inbox for the user to review. ' +
      'A rule reaches every future prompt of the agents it is on for, so write one only when it should always apply.',
    parameters: (Type) =>
      Type.Object({
        kind: Type.String({ description: 'skill, prompt, or rule' }),
        name: Type.String({ description: 'A short name, such as release-notes' }),
        description: Type.String({ description: 'One line the user reads first' }),
        body: Type.String({ description: 'The text itself, as Markdown' }),
        reason: Type.Optional(Type.String({ description: 'Why you are writing it' }))
      }),
    execute: async (input) => {
      const agentId = requireAgent(caller)
      const kind = text(input.kind)
      const name = text(input.name).trim()
      const description = text(input.description).trim()
      const body = text(input.body)
      const reason = text(input.reason).trim()
      if (!['skill', 'prompt', 'rule'].includes(kind)) throw invalid('kind must be skill, prompt, or rule.')
      if (!name || !body.trim()) throw invalid('A skill, prompt, or rule needs a name and a body.')
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw invalid('The body is larger than 64 KiB.')
      if (looksSecret(body)) throw invalid('The text looks like a credential, so it was not saved.')

      if (caller.vaultAccess === 'self' || caller.vaultAccess === 'propose' || caller.vaultAccess === 'curator') {
        const job = enqueueCuration(harness.env.root, { kind: 'registry', proposal: { kind, name, description, body, reason }, caller })
        harness.bus.emit({ type: 'wiki.changed' })
        return `Submitted proposal ${job.id} for curator review. Nothing has been activated.`
      }

      const { root } = harness.env
      const wiki = store.wikiDir(root)
      const id = `${kind}s/${store.slug(name)}`
      const existing = registry.list(root).find((item) => item.id === id)
      const choices = attachments.load(root)
      if (existing && !ownedByCaller(choices, id, agentId, !!existing.builtin)) {
        const parked = parkRegistryProposal(wiki, { kind: 'agent', runId: caller.runId ?? null, actor: actorLabel(caller) }, { kind, name, description, body, reason })
        harness.bus.emit({ type: 'wiki.changed' })
        return `The ${kind} change (${parked}) is in the Wiki Inbox: "${id}" is already used by others, so the user reviews it before it changes.`
      }

      registry.writeItem(root, kind, name, description, body, reason || `Written by ${actorLabel(caller)}`, actorLabel(caller))
      attachments.set(choices, [id], { agentId }, true, false)
      attachments.save(root, choices)
      reindexQuietly(root)
      harness.bus.emit({ type: 'plugins.changed' })
      inbox(wiki, 'applied', `Wrote ${kind} "${name}"`, `${reason || 'Written by an agent.'}\n\nBy ${actorLabel(caller)}. It is on only for that agent.`, [], null)
      return `Saved the ${kind} "${id}". It is on for you only; the user can switch it on for everyone.`
    }
  }
}

function pluginWriteTool(harness: Harness, caller: CallerContext): ToolSpec {
  return {
    name: PLUGIN_WRITE,
    label: caller.vaultAccess ? 'Propose a plugin' : 'Write a plugin',
    description: caller.vaultAccess ? 'Submit a plugin bundle for curator and user review. It remains inactive and untrusted; executable code requires an explicit user trust decision. Include at most 40 bounded files; never include credentials.' :
      'Write a plugin directly: a bundle of files that changes how agents work. It is switched on for you only. ' +
      'If it contains code (extensions/ or hooks.mjs), that code is trusted and runs in your sessions; nobody else runs it. ' +
      'Files by folder: skills/<name>/SKILL.md, prompts/<name>.md, extensions/<name>.ts, and hooks.mjs. Do not include package.json. Put no key or password in a file.',
    parameters: (Type) =>
      Type.Object({
        name: Type.String({ description: 'A short name, such as memory-to-docs' }),
        description: Type.String({ description: 'One line the user reads first' }),
        extends: Type.Optional(Type.Array(Type.String({ description: 'memory, wiki, or history' }))),
        reason: Type.Optional(Type.String({ description: 'Why you are writing it' })),
        files: Type.Array(Type.Object({ path: Type.String({ description: 'A path inside the plugin' }), content: Type.String() }), { maxItems: 40 })
      }),
    execute: async (input) => {
      const agentId = requireAgent(caller)
      const files = (Array.isArray(input.files) ? input.files : []).map((file) => ({ path: text((file as { path?: unknown }).path), content: text((file as { content?: unknown }).content) }))
      const proposal = {
        name: text(input.name),
        description: text(input.description),
        extends: (Array.isArray(input.extends) ? input.extends : []).filter((part): part is string => typeof part === 'string'),
        reason: text(input.reason),
        files
      }
      const checked = checkPluginProposal(proposal)
      if (caller.vaultAccess === 'self' || caller.vaultAccess === 'propose' || caller.vaultAccess === 'curator') {
        const job = enqueueCuration(harness.env.root, { kind: 'plugin', proposal, caller })
        harness.bus.emit({ type: 'wiki.changed' })
        return `Submitted proposal ${job.id}. Executable code requires user review and trust.`
      }
      const { root } = harness.env
      // Trust the packages that were there first, so the new one is not adopted with them.
      await ensureAdopted(harness)
      acceptPluginProposal(root, proposal)

      let note = ''
      try {
        if (checked.runsCode) {
          const loading = await loadingFor(harness, { agentId })
          const folder = resolve(join(root, 'plugins', checked.slug))
          const found = Object.entries(loading?.packageCode ?? {}).find(([dir]) => resolve(dir) === folder)
          if (!found) throw new Error('its code was not found after it was saved')
          await trust(harness, { agentId, hash: found[1].hash })
        }
        await attach(harness, { id: `package:${checked.slug}`, scope: { agentId } }, true)
      } catch (error) {
        note = ` It is saved but not switched on: ${error instanceof Error ? error.message : String(error)}. The user can switch it on in Plugins.`
      }
      harness.bus.emit({ type: 'plugins.changed' })
      inbox(store.wikiDir(root), 'applied', `Wrote plugin "${checked.slug}"`, `${proposal.reason || 'Written by an agent.'}\n\nBy ${actorLabel(caller)}.${checked.runsCode ? ' Its code runs only for that agent.' : ''}`, [], null)
      return note
        ? `The plugin "${checked.slug}" was written.${note}`
        : `The plugin "${checked.slug}" was written and is on for you only.${checked.runsCode ? ' Its code is trusted for your sessions.' : ''}`
    }
  }
}
