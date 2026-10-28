import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bodyOf } from '../core/frontmatter'

/** A skill folder name, without `skills/` or backticks. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9_-]*$/

/** One skill's file: what `skill_load` reads, and what the prompt compiler includes. */
export interface SkillFile {
  name: string
  /** The `SKILL.md` file the text came from. */
  path: string
  /** The skill folder that relative references resolve against. */
  baseDir: string
  /** The instructions after the frontmatter. */
  body: string
  /** Files in the skill's `scripts/` folder, empty when it has none. */
  helpers: string[]
}

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

/**
 * A skill by folder name: the pinned variant first, then the shipped `plugin-authoring` skill.
 * The body has its frontmatter removed. Returns null when no skill has that name.
 */
export function readSkillFile(variantDir: string | null | undefined, name: string): SkillFile | null {
  const wanted = name.trim().replace(/^skills\//, '').replace(/`/g, '')
  if (!SKILL_NAME.test(wanted)) return null
  const variant = variantDir ? join(variantDir, 'skills', wanted, 'SKILL.md') : null
  const builtin = wanted === 'plugin-authoring' && defaultSkillPaths(variantDir).length ? defaultSkillPath() : null
  const path = variant && existsSync(variant) && statSync(variant).isFile() ? variant : builtin
  if (!path) return null
  const baseDir = dirname(path)
  const scripts = join(baseDir, 'scripts')
  return {
    name: wanted,
    path,
    baseDir,
    body: bodyOf(readFileSync(path, 'utf8')),
    helpers: existsSync(scripts) ? readdirSync(scripts) : []
  }
}
