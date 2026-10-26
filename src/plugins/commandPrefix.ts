import { basename, dirname, extname } from 'node:path'

import { packageManifest } from './manifest'

export interface CommandSourceInfo {
  path: string
  source?: string
  origin?: 'package' | 'top-level'
  baseDir?: string
}

const slug = (value: string): string => {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  const prefix = /^[a-z]/.test(normalized) ? normalized : `plugin-${normalized || 'command'}`
  return prefix === 'plugin' || prefix === 'skill' ? `extension-${prefix}` : prefix
}

/** Stable command namespace for a Pi extension's owning package or loose extension file. */
export function pluginCommandPrefix(source: CommandSourceInfo): string {
  if (source.origin === 'package' && source.baseDir) {
    const manifest = packageManifest(source.baseDir)
    return manifest.commandPrefix ?? slug(manifest.name)
  }
  if (source.path.startsWith('builtin:')) return slug(source.path.slice('builtin:'.length))
  const synthetic = /^<[^:>]+:([^>]+)>$/.exec(source.path)
  if (synthetic) return slug(synthetic[1]!)
  const file = basename(source.path, extname(source.path))
  return slug(file === 'index' ? basename(dirname(source.path)) : file)
}
