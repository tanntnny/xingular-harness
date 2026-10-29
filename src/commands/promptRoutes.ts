import { resolve, sep } from 'node:path'
import type { PromptTemplate } from '@earendil-works/pi-coding-agent'
import type { Found } from '../plugins/discover'
import { pluginCommandPrefix } from '../plugins/commandPrefix'
import { packageManifest } from '../plugins/manifest'
import { commandRoutes, type CommandRoute } from './routes'

export type PromptOwner = Found & { commandOwner?: { prefix: string; owner: string } }

/** Resolve ownership from the Harness-selected resources, not the user-controlled filename. */
function promptOwners(path: string, found: readonly PromptOwner[]): PromptOwner[] {
  const target = resolve(path)
  return found.filter(item => item.kind === 'prompt' && item.packageRoot && (target === resolve(item.path) || target.startsWith(`${resolve(item.path)}${sep}`)))
    .sort((a, b) => b.path.length - a.path.length)
}

export function promptOwner(path: string, found: readonly PromptOwner[]): PromptOwner | undefined {
  return promptOwners(path, found)[0]
}

export function promptPackageRoot(prompt: PromptTemplate, found: readonly PromptOwner[]): string | null {
  return promptOwner(prompt.filePath, found)?.packageRoot ?? (prompt.sourceInfo.origin === 'package' ? prompt.sourceInfo.baseDir ?? null : null)
}

/** Rewrite only package-owned templates; the original content and Pi's argument substitution stay intact. */
export function namespacePrompts(prompts: readonly PromptTemplate[], found: readonly PromptOwner[], extensions: readonly CommandRoute[] = []): PromptTemplate[] {
  const loose: PromptTemplate[] = []
  const routes: (CommandRoute & { prompt: PromptTemplate })[] = []
  for (const prompt of prompts) {
    const owners = new Set(promptOwners(prompt.filePath, found).map(owner => owner.packageRoot))
    if (owners.size > 1) continue
    const packageRoot = promptPackageRoot(prompt, found)
    if (!packageRoot) {
      if (!prompt.name.includes(':')) loose.push(prompt)
      continue
    }
    const attribution = promptOwner(prompt.filePath, found)?.commandOwner
    const prefix = attribution?.prefix ?? pluginCommandPrefix({ path: prompt.filePath, origin: 'package', baseDir: packageRoot })
    const name = !attribution && packageManifest(packageRoot).defaultPrompt === prompt.name ? '' : prompt.name
    if (name && !/^[a-z][a-z0-9-]*$/.test(name)) continue
    routes.push({ prefix, name, owner: attribution?.owner ?? `package:${packageRoot}`, path: prompt.filePath, prompt })
  }
  const index = commandRoutes([...extensions, ...routes])
  const selected = routes.flatMap(route => {
    const key = `${route.prefix}:${route.name}`
    return !index.conflictingPrefixes.has(route.prefix) && index.routes.get(key)?.length === 1
      ? [{ ...route.prompt, name: key }]
      : []
  })
  return [...loose, ...selected]
}
