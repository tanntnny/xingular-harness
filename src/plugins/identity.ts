// Which plugin a found file belongs to, and what it is called there. The list a person sees and
// the choice of what loads both use this, so a switch on the page names exactly what stops loading.
import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'

import * as frontmatter from '../core/frontmatter'
import { BUILTIN_PREFIX, type Found } from './discover'
import { packageManifest } from './manifest'
import type { ContributionKind } from './types'

export { packageManifest } from './manifest'

export const FOUND_KINDS: Record<Found['kind'], ContributionKind> = { extension: 'code', hook: 'code', skill: 'skill', prompt: 'command', theme: 'theme', context: 'instruction' }

/** The id of the plugin a found item is listed under. */
export function pluginIdOf(item: Found): string {
  if (item.origin === 'builtin') return 'pi'
  if (item.packageRoot) return `package:${packageManifest(item.packageRoot).name}`
  return item.origin === 'home' ? 'home' : item.origin === 'project' ? 'project' : 'shared'
}

/** A found item's name and description as a person reads them. */
export function describeFound(item: Found): { name: string; description: string | null } {
  if (item.path.startsWith(BUILTIN_PREFIX)) return { name: item.path.slice(BUILTIN_PREFIX.length), description: null }
  const file = basename(item.path)
  if (item.kind === 'extension') return { name: file.startsWith('index.') ? basename(dirname(item.path)) : file, description: null }
  if (item.kind === 'context' || item.kind === 'theme' || item.kind === 'hook') return { name: file, description: null }
  const described = describeFile(item.path)
  return { name: described?.name ?? file, description: described?.description ?? '' }
}

export const contributionId = (pluginId: string, kind: ContributionKind, name: string): string => `${pluginId}/${kind}/${name}`

/** The ids a choice about a found item is stored under: the item itself, then its plugin. */
export function foundIds(item: Found): [string, string] {
  const pluginId = pluginIdOf(item)
  return [contributionId(pluginId, FOUND_KINDS[item.kind], describeFound(item).name), pluginId]
}

/** A Markdown file's `name` and `description` frontmatter; a `SKILL.md` is named after its folder. */
export function describeFile(path: string): { name: string; description: string } | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const front = frontmatter.parse(text)?.front ?? {}
  const fallback = basename(path) === 'SKILL.md' ? basename(dirname(path)) : basename(path).replace(/\.md$/, '')
  return { name: typeof front.name === 'string' && front.name.trim() ? front.name.trim() : fallback, description: typeof front.description === 'string' ? front.description.trim() : '' }
}
