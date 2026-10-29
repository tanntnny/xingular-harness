import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type * as Pi from '@earendil-works/pi-coding-agent'
import type { Found } from '../plugins/discover'
import type { CommandRoute } from './routes'
import { namespacePrompts, promptPackageRoot, type PromptOwner } from './promptRoutes'
import { pluginCommandPrefix } from '../plugins/commandPrefix'

const originalGetters = new WeakMap<Pi.DefaultResourceLoader, () => ReturnType<Pi.DefaultResourceLoader['getPrompts']>>()

/** Pi deduplicates by bare filename before its override; scan paths separately before qualifying. */
export async function wrapPromptLoader(pi: typeof Pi, loader: Pi.DefaultResourceLoader, found: readonly Found[], paths: readonly string[], cwd: string, agentDir: string, extensions: () => readonly CommandRoute[] = () => [], bare = new Set<string>()): Promise<Set<string>> {
  const scan = async (paths: readonly string[]): Promise<Pi.PromptTemplate[]> => {
    const files = paths.flatMap(path => {
      try {
        return statSync(path).isDirectory()
          ? readdirSync(path).filter(name => name.endsWith('.md') && !name.startsWith('.')).sort().map(name => join(path, name))
          : [path]
      } catch { return [] }
    })
    const templates: Pi.PromptTemplate[] = []
    for (const path of [...new Set(files)]) {
      const scanner = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager: pi.SettingsManager.inMemory({}), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalPromptTemplatePaths: [path] })
      await scanner.reload()
      templates.push(...scanner.getPrompts().prompts)
    }
    return templates
  }
  const templates = await scan(paths)
  const discovered = new Map<string, { owners: PromptOwner[]; prompts: Pi.PromptTemplate[] }>()
  for (const extension of loader.getExtensions().extensions) {
    if (extension.hidden) continue
    const handlers = extension.handlers.get('resources_discover')
    if (!handlers) continue
    const source = extension.sourceInfo
    extension.handlers.set('resources_discover', handlers.map((handler, index) => async (event, context) => {
      const result = await handler(event, context) as Pi.ResourcesDiscoverResult | undefined
      const key = `${extension.resolvedPath}:${index}`
      if (!result) discovered.delete(key)
      else {
        const paths = (result.promptPaths ?? []).map(path => resolve(dirname(extension.resolvedPath), path))
        const isPackage = source.origin === 'package' && !!source.baseDir
        const root = isPackage ? source.baseDir! : extension.resolvedPath
        const commandOwner = isPackage ? undefined : { prefix: pluginCommandPrefix(source), owner: `extension:${source.path}` }
        const owners: PromptOwner[] = paths.map(path => ({ kind: 'prompt', path, origin: isPackage ? 'package' : 'shared', packageRoot: root, source: source.source, project: source.scope === 'project', enabled: true, ...(commandOwner ? { commandOwner } : {}) }))
        discovered.set(key, { owners, prompts: await scan(paths) })
      }
      return result
    }))
  }
  bare.clear()
  for (const prompt of templates) if (promptPackageRoot(prompt, found)) bare.add(prompt.name)
  const getPrompts = originalGetters.get(loader) ?? loader.getPrompts.bind(loader)
  originalGetters.set(loader, getPrompts)
  loader.getPrompts = () => {
    const base = getPrompts()
    const dynamic = [...discovered.values()]
    const owners = [...found, ...dynamic.flatMap(item => item.owners)]
    const byPath = new Map(base.prompts.map(prompt => [prompt.filePath, prompt]))
    for (const prompt of [...templates, ...dynamic.flatMap(item => item.prompts)]) {
      if (byPath.has(prompt.filePath)) continue
      if (promptPackageRoot(prompt, owners) || ![...byPath.values()].some(item => item.name === prompt.name && !promptPackageRoot(item, owners))) byPath.set(prompt.filePath, prompt)
    }
    bare.clear()
    for (const prompt of byPath.values()) if (promptPackageRoot(prompt, owners)) bare.add(prompt.name)
    return { ...base, prompts: namespacePrompts([...byPath.values()], owners, extensions()) }
  }
  return bare
}
