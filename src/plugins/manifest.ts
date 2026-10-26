// What a package says about itself in its `package.json`: Pi's own fields, and under `harness`
// which part of the harness it extends, its command namespace and the file of hooks it runs.
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
  /** The hooks file, inside the package, or `null` when it has none. */
  hooks: string | null
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

export function packageManifest(packageRoot: string): PackageManifest {
  const manifest = readJsonOr<Raw>(join(packageRoot, 'package.json'), {})
  const own = (manifest.harness && typeof manifest.harness === 'object' && !Array.isArray(manifest.harness) ? manifest.harness : {}) as { extends?: unknown; hooks?: unknown; connectors?: unknown; commandPrefix?: unknown }
  return {
    name: typeof manifest.name === 'string' && manifest.name ? manifest.name : basename(packageRoot),
    description: typeof manifest.description === 'string' ? manifest.description : '',
    version: typeof manifest.version === 'string' ? manifest.version : null,
    extends: (Array.isArray(own.extends) ? own.extends : typeof own.extends === 'string' ? [own.extends] : []).filter((id): id is string => typeof id === 'string' && !!id),
    commandPrefix: typeof own.commandPrefix === 'string' && /^[a-z][a-z0-9-]*$/i.test(own.commandPrefix) && !['plugin', 'skill'].includes(own.commandPrefix.toLowerCase()) ? own.commandPrefix.toLowerCase() : null,
    hooks: inside(own.hooks),
    connectorTemplates: (Array.isArray(own.connectors) ? own.connectors : []).flatMap((value) => {
      const parsed = connectorTemplateSchema.safeParse(value)
      return parsed.success ? [parsed.data] : []
    })
  }
}
