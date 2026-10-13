// Observe Pi's structured resource discovery without running code while the catalogue is read.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type * as Pi from '@earendil-works/pi-coding-agent'

import { charCount } from '../core/text'
import { FOUND_KINDS, describeFound } from './identity'
import type { Found } from './discover'
import type { Loading, Registered, RuntimeResource } from './plugins'

export function runtimeOwner(loading: Loading, path: string): Found | undefined {
  return loading.found.find((item) => item.kind === 'extension' && (item.path === path || path.startsWith(`${item.path}/`)))
}

export function registrationHash(loading: Loading, path: string): string | null {
  const owner = runtimeOwner(loading, path)
  if (owner?.project) return loading.projectCode?.hash ?? null
  if (owner?.packageRoot) return loading.packageCode[owner.packageRoot]?.hash ?? null
  try { return createHash('sha256').update(readFileSync(path)).digest('hex') } catch { return null }
}

/** A discovered resource has the same identity for its switch, catalogue and load decision. */
export function resourceOf(owner: Found, kind: 'skill' | 'prompt' | 'theme', path: string): RuntimeResource {
  const found = { ...owner, kind, path }
  const described = describeFound(found)
  let chars: number | null = null
  try { chars = charCount(readFileSync(path, 'utf8')) } catch { /* Missing files remain observable. */ }
  return { kind: FOUND_KINDS[kind] as RuntimeResource['kind'], name: described.name, path, chars }
}

/** Wrap each handler separately so identical extension basenames never lose their owner. */
export function observeResources(pi: typeof Pi, loader: Pi.DefaultResourceLoader, loading: Loading, records: Registered[], publish: () => void): void {
  for (const extension of loader.getExtensions().extensions) {
    if (extension.hidden) continue
    const path = extension.resolvedPath || extension.path
    const owner = runtimeOwner(loading, path)
    const record = records.find((entry) => entry.path === path)
    if (!owner || !record) continue
    const handlers = extension.handlers.get('resources_discover')
    if (!handlers) continue
    const observations = new Map<number, RuntimeResource[]>()
    extension.handlers.set('resources_discover', handlers.map((handler, index) => async (event, context) => {
      const result = await handler(event, context) as Pi.ResourcesDiscoverResult | undefined
      if (!result) {
        observations.delete(index)
        record.resources = [...observations.values()].flat()
        publish()
        return result
      }
      const collected: RuntimeResource[] = []
      const allowed = (kind: 'skill' | 'prompt' | 'theme', resourcePath: string): boolean => {
        const resource = resourceOf(owner, kind, resourcePath)
        collected.push(resource)
        return loading.resourceAllowed?.({ ...owner, kind, path: resourcePath }) !== false
      }
      const absolute = (entry: string): string => resolve(dirname(path), entry)
      const skills = pi.loadSkills({ cwd: dirname(path), agentDir: dirname(path), includeDefaults: false, skillPaths: (result.skillPaths ?? []).map(absolute) }).skills
      const scanner = new pi.DefaultResourceLoader({ cwd: dirname(path), agentDir: dirname(path), settingsManager: pi.SettingsManager.inMemory({}), noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true, additionalPromptTemplatePaths: (result.promptPaths ?? []).map(absolute) })
      await scanner.reload()
      const prompts = scanner.getPrompts().prompts
      const themes = (result.themePaths ?? []).map(absolute).flatMap((theme) => {
        try {
          if (statSync(theme).isDirectory()) return readdirSync(theme).filter((name) => {
            if (!name.endsWith('.json')) return false
            try { return statSync(resolve(theme, name)).isFile() } catch { return false }
          }).map((name) => resolve(theme, name))
        } catch { /* Preserve missing paths for Pi's diagnostics. */ }
        return [theme]
      })
      const filtered = {
        skillPaths: skills.filter((skill) => allowed('skill', skill.filePath)).map((skill) => skill.filePath),
        promptPaths: prompts.filter((prompt) => allowed('prompt', prompt.filePath)).map((prompt) => prompt.filePath),
        themePaths: themes.filter((theme) => allowed('theme', theme))
      }
      observations.set(index, collected)
      record.resources = [...new Map([...observations.values()].flat().map((entry) => [`${entry.kind}:${entry.path}`, entry])).values()]
      publish()
      return filtered
    }))
  }
}
