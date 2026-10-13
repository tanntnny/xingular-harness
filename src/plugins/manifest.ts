// What a package says about itself in its `package.json`: Pi's own fields, and under `harness`
// which part of the harness it extends and the file of hooks the harness runs for it.
import { basename, join } from 'node:path'

import { readJsonOr, safeRelative } from '../core/fs'

export interface PackageManifest {
  name: string
  description: string
  version: string | null
  /** The parts it adds to, by id: `memory`, `wiki`, `history`. */
  extends: string[]
  /** The hooks file, inside the package, or `null` when it has none. */
  hooks: string | null
}

interface Raw {
  name?: unknown
  description?: unknown
  version?: unknown
  harness?: unknown
}

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
  const own = (manifest.harness && typeof manifest.harness === 'object' && !Array.isArray(manifest.harness) ? manifest.harness : {}) as { extends?: unknown; hooks?: unknown }
  return {
    name: typeof manifest.name === 'string' && manifest.name ? manifest.name : basename(packageRoot),
    description: typeof manifest.description === 'string' ? manifest.description : '',
    version: typeof manifest.version === 'string' ? manifest.version : null,
    extends: (Array.isArray(own.extends) ? own.extends : typeof own.extends === 'string' ? [own.extends] : []).filter((id): id is string => typeof id === 'string' && !!id),
    hooks: inside(own.hooks)
  }
}
