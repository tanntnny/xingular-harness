// What a package says about itself in its `package.json`: Pi's own fields, and under `harness`
// which part of the harness it extends, its command namespace, the file of hooks it runs and the
// folder of subagent profiles it brings. A package written for other agent harnesses may have no
// `package.json`; its `plugin.json` then names and describes it.
import { basename, join } from 'node:path'
import { z } from 'zod'

import { readJsonOr, safeRelative } from '../core/fs'
import type { ConnectorTemplate } from './types'

export interface PackageManifest {
  name: string
  description: string
  version: string | null
  /** The parts it adds to, by id: `memory`, `wiki`, `history`. */
  extends: string[]
  /** Stable terminal command namespace, or `null` to use the normalized package name. */
  commandPrefix: string | null
  /** A prompt template name exposed only at the package namespace root. */
  defaultPrompt: string | null
  /** The hooks file, inside the package, or `null` when it has none. */
  hooks: string | null
  /** The folder of subagent profiles, inside the package. `agents` unless the manifest names another. */
  agents: string
  /** Data-only remote connector forms. Invalid templates are ignored; none can carry credentials. */
  connectorTemplates: ConnectorTemplate[]
}

interface Raw {
  name?: unknown
  description?: unknown
  version?: unknown
  harness?: unknown
}

const connectorTemplateSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(120),
  description: z.string().max(500),
  url: z.string().url().startsWith('https://'),
  auth: z.enum(['none', 'headers', 'oauth']),
  oauthClient: z.enum(['dynamic', 'user']).nullable(),
  oauthScopes: z.array(z.string().max(500)).max(30),
  docsUrl: z.string().url().startsWith('https://').nullable(),
  fields: z.array(z.object({
    header: z.string().regex(/^[A-Za-z0-9_-]+$/),
    label: z.string().min(1).max(120),
    prefix: z.string().max(100),
    help: z.string().max(500)
  }).strict()).max(12),
  setup: z.array(z.string().max(1000)).max(20),
  notice: z.string().max(1000).nullable()
}).strict().superRefine((template, context) => {
  const oauth = template.auth === 'oauth'
  const headers = template.auth === 'headers'
  if (oauth !== (template.oauthClient !== null)) context.addIssue({ code: 'custom', message: 'OAuth templates must state a client type and other templates must not.', path: ['oauthClient'] })
  if (headers !== (template.fields.length > 0)) context.addIssue({ code: 'custom', message: 'Header templates must declare input fields and other templates must not.', path: ['fields'] })
})

/** A path inside the package, or `null` for one that is missing, absolute, or climbs out of it. */
function inside(path: unknown): string | null {
  if (typeof path !== 'string' || !path.trim()) return null
  try {
    return safeRelative(path.replace(/^\.\//, ''))
  } catch {
    return null
  }
}

/** The plugin manifests other agent harnesses read, in the order they are tried. */
const PLUGIN_MANIFESTS = ['plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'] as const

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

function pluginJson(packageRoot: string): Raw {
  for (const file of PLUGIN_MANIFESTS) {
    const found = readJsonOr<unknown>(join(packageRoot, file), null)
    if (found && typeof found === 'object' && !Array.isArray(found)) return found as Raw
  }
  return {}
}

export function packageManifest(packageRoot: string): PackageManifest {
  const manifest = readJsonOr<Raw>(join(packageRoot, 'package.json'), {})
  // Only a package without a name of its own is described by its plugin.json.
  const plugin = text(manifest.name) ? {} : pluginJson(packageRoot)
  const own = (manifest.harness && typeof manifest.harness === 'object' && !Array.isArray(manifest.harness) ? manifest.harness : {}) as { extends?: unknown; hooks?: unknown; agents?: unknown; connectors?: unknown; commandPrefix?: unknown; defaultPrompt?: unknown }
  const pluginName = text(plugin.name)
  return {
    name: text(manifest.name) ?? (pluginName && /^[a-z0-9][a-z0-9._-]*$/i.test(pluginName) ? pluginName : basename(packageRoot)),
    description: text(manifest.description) ?? text(plugin.description) ?? '',
    version: text(manifest.version) ?? text(plugin.version),
    extends: (Array.isArray(own.extends) ? own.extends : typeof own.extends === 'string' ? [own.extends] : []).filter((id): id is string => typeof id === 'string' && !!id),
    commandPrefix: typeof own.commandPrefix === 'string' && /^[a-z][a-z0-9-]*$/i.test(own.commandPrefix) && !['plugin', 'skill'].includes(own.commandPrefix.toLowerCase()) ? own.commandPrefix.toLowerCase() : null,
    defaultPrompt: typeof own.defaultPrompt === 'string' && /^[a-z][a-z0-9-]*$/.test(own.defaultPrompt) ? own.defaultPrompt : null,
    hooks: inside(own.hooks),
    agents: inside(own.agents) ?? 'agents',
    connectorTemplates: (Array.isArray(own.connectors) ? own.connectors : []).flatMap((value) => {
      const parsed = connectorTemplateSchema.safeParse(value)
      return parsed.success ? [parsed.data] : []
    })
  }
}
