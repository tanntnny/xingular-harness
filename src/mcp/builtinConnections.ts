// Release-owned connectors use the same scoped broker as saved connections, but do not write
// connection records or credentials to the person's state directory.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

import { attached, load, type AttachScope } from '../plugins/attachments'
import { connectionSchema, type Connection } from './types'

export const REA_CONNECTION_ID = 'builtin-rea'
export const REA_PLUGIN_ID = 'rea'
export const REA_SKILL_CONTRIBUTION = 'rea/skill/reverse-engineer-anything'
export const REA_VERSION = '6.8.0'

/** The installed upstream launcher checks that the runtime and skill share this exact version. */
export function reaLauncher(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const root = dirname(require.resolve('rea-agents/package.json'))
    const manifest = require(join(root, 'package.json')) as { name?: string; version?: string }
    const launcher = join(root, 'scripts', 'rea.mjs')
    return manifest.name === 'rea-agents' && manifest.version === REA_VERSION && existsSync(launcher) && existsSync(join(root, 'dist', 'mcp', 'main.js')) ? launcher : null
  } catch {
    return null
  }
}

export function reaRuntimeSupported(version = process.versions.node): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number)
  if (major === 22) return minor > 23 || minor === 23 && patch >= 4
  if (major === 24) return minor > 22 || minor === 22 && patch >= 1
  return major > 26 || major === 26 && (minor > 12 || minor === 12 && patch >= 1)
}

/** Scope is checked again for every call; an enabled plugin never grants a tool approval. */
export function builtinConnections(root: string | null, scope: AttachScope): Connection[] {
  if (!root) return []
  const choices = load(root)
  if (!attached(choices, [REA_PLUGIN_ID], scope, false)) return []
  const configured = choices.settings[REA_PLUGIN_ID]?.callTimeoutSeconds
  const callTimeoutSeconds = typeof configured === 'number' && Number.isInteger(configured) && configured >= 1 && configured <= 1800 ? configured : 450
  return [connectionSchema.parse({
    id: REA_CONNECTION_ID, name: 'REA', kind: 'local', enabled: true, global: true,
    command: process.execPath, args: [reaLauncher() ?? '', 'mcp'], callTimeoutSeconds,
    readTools: []
  })]
}
