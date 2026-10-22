// The experience library: what earlier refinements in one scope and area adopted, and why.
// Read by improvers before each task, appended after it. The whole variant is carried, never a
// summary.
//
//   <data>/library/<scope>/<area>/INDEX.md
//   <data>/library/<scope>/<area>/variants/<task>/variant/<rel>   the full adopted variant
//   <data>/library/<scope>/<area>/variants/<task>/EXPERIENCE.md   why it was picked, and the lesson
//
// Ported from Harness² (Apache-2.0, Google LLC; `harness2/core/library.py`).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { safeId } from '../core/fs'
import { PI_SURFACE, type SurfaceSpec, type Variant } from '../variant/surface'
import { alwaysOnText, pluginNames, readVariant, skillNames, subagentNames, writeVariant } from '../variant/variant'
import { patterns } from '../variant/surface'
import { assertVariantHasNoGraderVerdicts } from './evidence'

export interface Experience {
  cue: string
  lesson: string
  evidence: string
  confidence?: string
  /** The edit-by-edit record the lesson rests on. */
  edits?: string
}

export function hasExperience(experience: Partial<Experience> | null | undefined): experience is Experience {
  return Boolean(experience) && (['cue', 'lesson', 'evidence'] as const).every((key) => typeof experience![key] === 'string' && experience![key]!.trim().length > 0)
}

/** One folder name for a task or area: separators collapse, nothing escapes. */
export function slug(text: string): string {
  return text.replace(/\s*[/\\]\s*/g, '__').replace(/[^A-Za-z0-9_.\-]/g, '_').replace(/^\.+/, '_').slice(0, 120).trim() || 'unknown'
}

export interface LibraryEntry {
  task: string
  label: string
  runId: string
  cue: string | null
  inventory: string
}

export function libraryRoot(root: string): string {
  return join(root, 'library')
}

export class Library {
  constructor(readonly root: string, readonly scope: string, readonly area: string = scope, readonly surface: SurfaceSpec = PI_SURFACE) {
    safeId(scope)
  }

  get dir(): string {
    return join(libraryRoot(this.root), this.scope, slug(this.area))
  }

  get index(): string {
    return join(this.dir, 'INDEX.md')
  }

  entryDir(task: string): string {
    return join(this.dir, 'variants', slug(task))
  }

  /** The folder handed to an improver, or null when nothing has been learned here yet. */
  contextDir(): string | null {
    return existsSync(this.index) && this.entries().length ? this.dir : null
  }

  entries(): string[] {
    const dir = join(this.dir, 'variants')
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'EXPERIENCE.md'))).map((entry) => entry.name).sort()
    } catch {
      return []
    }
  }

  variantOf(task: string): Variant {
    return readVariant(this.surface, join(this.entryDir(task), 'variant'))
  }

  experienceText(task: string): string | null {
    try {
      return readFileSync(join(this.entryDir(task), 'EXPERIENCE.md'), 'utf8')
    } catch {
      return null
    }
  }

  list(): LibraryEntry[] {
    return this.entries().map((name) => {
      const text = readFileSync(join(this.dir, 'variants', name, 'EXPERIENCE.md'), 'utf8')
      return {
        task: name,
        label: /^- adopted: `([^`]+)`/m.exec(text)?.[1] ?? '',
        runId: /\(run `([^`]+)`\)/.exec(text)?.[1] ?? '',
        cue: field(text, 'cue'),
        inventory: inventory(this.surface, this.variantOf(name))
      }
    })
  }

  /** Drops these tasks' entries and rebuilds the index; unknown tasks are ignored. */
  forget(tasks: readonly string[]): void {
    let removed = false
    for (const task of tasks) {
      const dir = this.entryDir(task)
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true })
        removed = true
      }
    }
    if (removed) this.rebuildIndex()
  }

  /**
   * Stores one adopted harness and why it was adopted, then rebuilds the index. Nothing is
   * stored without a supported lesson. Returns the entry folder, or null.
   */
  add(task: string, variant: Variant, input: { why?: string; label?: string; runId?: string; experience?: Partial<Experience> | null }): string | null {
    const experience = input.experience
    if (!hasExperience(experience)) return null
    assertVariantHasNoGraderVerdicts(variant)
    assertVariantHasNoGraderVerdicts({ 'EXPERIENCE.md': JSON.stringify(experience) + (input.why ?? '') })
    const dir = this.entryDir(task)
    rmSync(join(dir, 'variant'), { recursive: true, force: true })
    writeVariant(this.surface, variant, join(dir, 'variant'), { stubs: false })
    const lines = [`# ${task}`, '', `- adopted: \`${input.label ?? ''}\`${input.runId ? `  (run \`${input.runId}\`)` : ''}`, `- components: ${inventory(this.surface, variant)}`, '']
    if (input.why?.trim()) lines.push('## Why this was chosen', input.why.trim(), '')
    if (experience.edits?.trim()) lines.push('## What each edit did', experience.edits.trim(), '')
    lines.push('## Transferable lesson')
    for (const key of ['cue', 'lesson', 'evidence', 'confidence'] as const) if (experience[key]) lines.push(`- **${key}**: ${String(experience[key]).trim()}`)
    lines.push('')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'EXPERIENCE.md'), lines.join('\n'))
    this.rebuildIndex()
    return dir
  }

  rebuildIndex(): string {
    const rows = [`# Library — ${this.area}`, '', 'Each entry is an earlier task in THIS area whose harness was chosen, stored with its FULL component variant and why it was picked. Browse this index, then open the entries that look relevant to the matter in front of you.', '']
    const names = this.entries()
    if (!names.length) rows.push('_(empty — this is the first task in this area)_')
    for (const name of names) {
      const cue = field(readFileSync(join(this.dir, 'variants', name, 'EXPERIENCE.md'), 'utf8'), 'cue')
      rows.push(`## \`variants/${name}/\``, `- variant: \`variants/${name}/variant/\` — ${inventory(this.surface, this.variantOf(name))}`, `- why:     \`variants/${name}/EXPERIENCE.md\``)
      if (cue) rows.push(`- cue:     ${cue}`)
      rows.push('')
    }
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.index, rows.join('\n'))
    return this.index
  }
}

/** A one-line census of the components in a variant. */
export function inventory(surface: SurfaceSpec, variant: Variant): string {
  const scripts = Object.keys(variant).filter((rel) => patterns(surface).script.test(rel)).length
  const counts: [string, number][] = [
    ['skills', skillNames(surface, variant).length],
    ['sub_agents', subagentNames(surface, variant).length],
    ['scripts', scripts],
    ['plugins', pluginNames(surface, variant).length]
  ]
  const bits = counts.filter(([, n]) => n).map(([name, n]) => `${n} ${name}`)
  return `${bits.length ? bits.join(', ') : 'always-on edits only'}; ${alwaysOnText(surface, variant).length.toLocaleString('en-US')} always-on chars`
}

function field(text: string, name: string): string | null {
  for (const line of text.split('\n')) if (line.startsWith(`- **${name}**:`)) return line.split(':').slice(1).join(':').trim()
  return null
}

/** Every scope that has a library. */
export function libraryScopes(root: string): string[] {
  try {
    return readdirSync(libraryRoot(root), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

/** Every area a scope has entries in. */
export function libraryAreas(root: string, scope: string): string[] {
  try {
    return readdirSync(join(libraryRoot(root), safeId(scope)), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}
