import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Locate release-owned resources from source, the SDK, or a bundled executable. */
export function defaultSkillPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const path = join(dir, 'builtin', 'skills', 'plugin-authoring', 'SKILL.md')
    if (existsSync(path)) return path
    const parent = dirname(dir)
    if (parent === dir) throw new Error('The bundled plugin-authoring skill is missing.')
    dir = parent
  }
}

/** Variant skills win on a name collision, without modifying a pinned variant. */
export function defaultSkillPaths(variantDir: string | null | undefined): string[] {
  return variantDir && existsSync(join(variantDir, 'skills', 'plugin-authoring', 'SKILL.md')) ? [] : [defaultSkillPath()]
}
