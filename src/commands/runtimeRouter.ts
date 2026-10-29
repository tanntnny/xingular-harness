import { resolve, sep } from 'node:path'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { HarnessError } from '../core/errors'
import type { Found } from '../plugins/discover'
import { pluginCommandPrefix } from '../plugins/commandPrefix'
import { commandRoutes } from './routes'

/** Intercept before Pi can dispatch a bare extension command. */
export function installPluginCommandRouter(session: AgentSession, found: readonly Found[], barePrompts: Set<string>): () => string[] {
  const registrations = () => session.extensionRunner.getRegisteredCommands().map(command => {
    const source = command.sourceInfo
    const path = resolve(source.path)
    const owner = found.filter(item => item.kind === 'extension' && item.packageRoot && (path === resolve(item.path) || path.startsWith(`${resolve(item.path)}${sep}`))).sort((a, b) => b.path.length - a.path.length)[0]
    const prefix = pluginCommandPrefix(owner?.packageRoot ? { path: source.path, origin: 'package', baseDir: owner.packageRoot } : source)
    return { ...command, prefix, owner: owner?.packageRoot ? `package:${owner.packageRoot}` : source.origin === 'package' ? `package:${source.baseDir ?? source.source}` : `extension:${source.path}`, path: source.path }
  })
  const originalPrompt = session.prompt.bind(session)
  session.prompt = async (text, options) => {
    if (options?.expandPromptTemplates === false) return originalPrompt(text, options)
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
    if (match) {
      const name = match[1]!
      const index = commandRoutes(registrations())
      const promptNames = new Set(session.resourceLoader.getPrompts().prompts.map(prompt => prompt.name))
      if (name.startsWith('plugin:') || index.byName.has(name) || (barePrompts.has(name) && !promptNames.has(name))) {
        throw new HarnessError('invalid_request', `Plugin command /${name} requires its owner prefix.`)
      }
      const separator = name.indexOf(':')
      const prefix = separator < 0 ? '' : name.slice(0, separator)
      if (separator > 0 && index.ownersByPrefix.has(prefix)) {
        if (index.conflictingPrefixes.has(prefix)) throw new HarnessError('invalid_request', `Plugin prefix /${prefix}: is ambiguous.`)
        const matches = index.routes.get(name) ?? []
        if (matches.length > 1 || matches.length === 1 && promptNames.has(name)) throw new HarnessError('invalid_request', `Plugin command /${name} is ambiguous.`)
        if (matches.length === 1) {
          const command = session.extensionRunner.getCommand(matches[0]!.invocationName)
          if (!command) throw new HarnessError('invalid_request', `Plugin command /${name} is unavailable.`)
          await command.handler(match[2]?.trim() ?? '', session.extensionRunner.createCommandContext())
          return
        }
        if (!promptNames.has(name)) throw new HarnessError('invalid_request', `Unknown plugin command /${name}.`)
      }
    }
    await originalPrompt(text, options)
  }
  return () => [...registrations().map(command => `${command.prefix}:${command.name}`), ...session.resourceLoader.getPrompts().prompts.map(prompt => prompt.name)]
}
