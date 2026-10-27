// One entry point for every History, Wiki and skill call a session makes, whichever way it
// reaches the harness (a Pi tool, the bundled server, a terminal session).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Bus } from '../core/bus'
import { projectOf, type CallerContext } from '../core/caller'
import type { HarnessEnv } from '../core/env'
import { HarnessError, invalid } from '../core/errors'
import * as recall from '../history/recall'
import * as trajectory from '../history/trajectory'
import * as notes from '../wiki/notes'
import * as proposals from '../plugins/proposals'
import type { HarnessCall } from './definitions'
import { defaultSkillPaths } from './defaultSkills'

export type DispatchEnv = HarnessEnv & { bus?: Bus }
export type Params = Record<string, unknown>

export interface DispatchOptions {
  /** The run's variant on disk, for `skill_load`. */
  variantDir?: string | null
}

function str(params: Params, key: string): string {
  const value = params[key]
  return typeof value === 'string' ? value : ''
}

/** Runs one call and returns its reply as text for a model. */
export function dispatch(env: DispatchEnv, context: CallerContext, call: HarnessCall | string, params: Params, options: DispatchOptions = {}): string {
  switch (call) {
    case 'recall.search':
      return recall.searchTool(env, context, params)
    case 'recall.read':
      return recall.readTool(env, context, params)
    case 'trajectory.search':
      return trajectory.searchTool(env, context, params)
    case 'trajectory.read':
      return trajectory.readTool(env, context, params)
    case 'wiki.search': {
      const project = str(params, 'project') || projectOf(env.root, context)?.slug || null
      const hits = notes.search(env.root, str(params, 'query'), { project, limit: typeof params.limit === 'number' ? params.limit : 10 })
      if (!hits.length) return 'No note matches.'
      return hits.map((hit) => `- ${hit.path} — ${hit.title}\n  ${hit.excerpt}`).join('\n')
    }
    case 'wiki.read': {
      const note = notes.read(env.root, str(params, 'path'))
      const tail = [note.links.length ? `Links to: ${note.links.join(', ')}` : '', note.backlinks.length ? `Linked from: ${note.backlinks.join(', ')}` : ''].filter(Boolean).join('\n')
      return `# ${note.title} (${note.path}, updated ${note.updatedAt})\n\n${note.body}${tail ? `\n\n---\n${tail}` : ''}`
    }
    case 'wiki.list': {
      const project = str(params, 'project')
      const found = notes.list(env.root, project ? { project: project === 'library' ? null : project } : {})
      const shown = project === 'library' ? found.filter((note) => note.path.startsWith('library/')) : found
      return shown.length ? shown.map((note) => `- ${note.path} — ${note.title}`).join('\n') : 'No notes yet.'
    }
    case 'wiki.write': {
      const note = notes.write(env.root, str(params, 'path'), str(params, 'text'), { actor: context.agentName ?? context.agentId ?? 'agent', reason: 'Written by an agent' })
      env.bus?.emit({ type: 'wiki.changed' })
      return `Saved ${note.path}.`
    }
    case 'plugin.propose': {
      const proposal = proposals.create(env.root, params.name, params.description, params.files)
      return `Proposed ${proposal.name} (${proposal.id}). A person can review it in the plugin manager; it is not installed or enabled.`
    }
    case 'skill.load':
      return loadSkill(options.variantDir ?? null, str(params, 'name'))
    default:
      throw new HarnessError('unknown_method', `Unknown harness call ${call}.`)
  }
}

/** A skill's text from the run's variant, or the list of its skills. */
export function loadSkill(variantDir: string | null, name: string): string {
  const skills = variantDir && existsSync(join(variantDir, 'skills')) ? readdirSync(join(variantDir, 'skills'), { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(variantDir, 'skills', entry.name, 'SKILL.md'))).map((entry) => entry.name).sort() : []
  const defaults = defaultSkillPaths(variantDir)
  if (defaults.length) skills.push('plugin-authoring')
  skills.sort()
  const wanted = name.trim().replace(/^skills\//, '').replace(/`/g, '')
  if (!wanted) return skills.length ? `Your skills: ${skills.join(', ')}. Load one with skill_load and its name.` : 'You have no skills.'
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(wanted)) throw invalid('A skill name is lowercase letters, digits, _ or -.')
  if (!skills.includes(wanted)) return `There is no skill named ${wanted}.${skills.length ? ` Your skills: ${skills.join(', ')}.` : ''}`
  if (wanted === 'plugin-authoring' && defaults.length) return readFileSync(defaults[0]!, 'utf8')
  const dir = join(variantDir!, 'skills', wanted)
  const helpers = existsSync(join(dir, 'scripts')) ? readdirSync(join(dir, 'scripts')) : []
  return `${readFileSync(join(dir, 'SKILL.md'), 'utf8')}${helpers.length ? `\n\n(This skill's helpers are in ${join(dir, 'scripts')}: ${helpers.join(', ')}.)` : ''}`
}
