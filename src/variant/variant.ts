// Reading, writing, validating, repairing and comparing a variant. The edit contract is
// omitted-is-inherited: an edit names only the files it changes.
//
// Ported from Harness² (Apache-2.0, Google LLC; `harness2/core/variant.py`).
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'

import { componentOf, patterns, type ComponentId, type SurfaceSpec, type Variant } from './surface'

/** Scripts the harness itself ships; a reference to one needs no file in the variant. */
export const RESERVED_SCRIPTS: ReadonlySet<string> = new Set()

/** Normalises a relative path and refuses one that escapes the variant. */
export function normalizeRel(rel: string): string {
  let r = String(rel).trim().replace(/\\/g, '/')
  if (r.startsWith('/') || r.split('/').includes('..')) throw new Error(`path escapes the harness: ${JSON.stringify(rel)}`)
  while (r.startsWith('./')) r = r.slice(2)
  return r.replace(/^\/+|\/+$/g, '')
}

/** Whether a path is on the editable surface. Never throws. */
export function isAllowed(surface: SurfaceSpec, rel: string): boolean {
  let clean: string
  try {
    clean = normalizeRel(rel)
  } catch {
    return false
  }
  return surface.alwaysOn.includes(clean) || componentOf(surface, clean) !== null
}

export function skillNames(surface: SurfaceSpec, variant: Variant): string[] {
  return names(variant, patterns(surface).skill)
}

export function subagentNames(surface: SurfaceSpec, variant: Variant): string[] {
  return names(variant, patterns(surface).subagent)
}

export function pluginNames(surface: SurfaceSpec, variant: Variant): string[] {
  return names(variant, patterns(surface).plugin)
}

function names(variant: Variant, rx: RegExp): string[] {
  const found = new Set<string>()
  for (const rel of Object.keys(variant)) {
    const m = rx.exec(rel)
    if (m?.[1]) found.add(m[1])
  }
  return [...found].sort()
}

function stubPaths(surface: SurfaceSpec): Set<string> {
  return new Set(surface.stubs.map(([rel]) => rel))
}

function walk(dir: string): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries.sort()) {
    if (name === '__pycache__' || name === '.DS_Store' || name === 'node_modules') continue
    const path = join(dir, name)
    let isDir = false
    try {
      isDir = statSync(path).isDirectory()
    } catch {
      continue
    }
    if (isDir) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

/**
 * Every file on the editable surface under `dir`, README stubs excluded. Pass `rejected` to
 * collect paths that exist but are off the surface.
 */
export function readVariant(surface: SurfaceSpec, dir: string, rejected?: string[]): Variant {
  const out: Variant = {}
  const stubs = stubPaths(surface)
  for (const path of walk(dir)) {
    const rel = relative(dir, path).split(sep).join('/')
    if (stubs.has(rel)) continue
    if (!isAllowed(surface, rel)) {
      rejected?.push(rel)
      continue
    }
    out[rel] = readFileSync(path, 'utf8')
  }
  return out
}

/** Whether `dir` holds a variant: at least one always-on file. */
export function isVariant(surface: SurfaceSpec, dir: string): boolean {
  return surface.alwaysOn.some((rel) => {
    try {
      return statSync(join(dir, rel)).isFile()
    } catch {
      return false
    }
  })
}

/**
 * Writes exactly `variant` to `dest`. Always-on files are present even when empty; files off the
 * surface are kept, editable files already there are replaced.
 */
export function writeVariant(surface: SurfaceSpec, variant: Variant, dest: string, options: { stubs?: boolean } = {}): string {
  mkdirSync(dest, { recursive: true })
  const stubs = stubPaths(surface)
  for (const path of walk(dest).reverse()) {
    const rel = relative(dest, path).split(sep).join('/')
    if (isAllowed(surface, rel) || stubs.has(rel)) unlinkSync(path)
  }
  for (const rel of surface.alwaysOn) {
    if (!(rel in variant)) {
      const path = join(dest, rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '')
    }
  }
  for (const [rel, text] of Object.entries(variant)) {
    const path = join(dest, normalizeRel(rel))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  if (options.stubs !== false) {
    for (const [rel, body] of surface.stubs) {
      const path = join(dest, rel)
      try {
        statSync(path)
      } catch {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, body)
      }
    }
  }
  return dest
}

/** The always-on text, as the model sees it, joined in surface order. */
export function alwaysOnText(surface: SurfaceSpec, variant: Variant): string {
  return surface.alwaysOn.map((rel) => variant[rel] ?? '').join('\n\n')
}

function frontmatterField(body: string, field: string): string | null {
  const m = new RegExp(`^${field}:\\s*(.+)$`, 'm').exec(body.slice(0, 600))
  return m?.[1]?.trim() ?? null
}

/**
 * Gives every skill a trigger line in the always-on text, mutating `variant`. Returns the names
 * repaired. A line that would push the text over the cap is skipped.
 */
export function autotrigger(surface: SurfaceSpec, variant: Variant, alwaysOnMax = surface.alwaysOnMax): string[] {
  let body = alwaysOnText(surface, variant)
  const fixed: string[] = []
  for (const name of skillNames(surface, variant)) {
    if (body.includes(name)) continue
    const desc = frontmatterField(variant[`${surface.skillDir}/${name}/SKILL.md`] ?? '', 'description')?.replace(/\.$/, '') ?? `the ${name} workflow applies`
    const line = surface.triggerLine.replace('{name}', name).replace('{desc}', desc)
    if (body.length + line.length + 2 > alwaysOnMax) continue
    const current = variant[surface.autotriggerFile] ?? ''
    variant[surface.autotriggerFile] = current.trim() ? `${current.replace(/\s+$/, '')}\n${line}\n` : `${line}\n`
    body = alwaysOnText(surface, variant)
    fixed.push(name)
  }
  return fixed
}

export interface VariantCensus {
  alwaysOnChars: number
  files: number
  skills: number
  subagents: number
  scripts: number
  plugins: number
}

export interface ValidateOptions {
  allowSubagents?: boolean
  alwaysOnMax?: number
  reservedScripts?: ReadonlySet<string>
  /** Check that scripts compile with the interpreters on this machine. On by default. */
  compileScripts?: boolean
}

/** A variant that does not validate. `problems` is written to be fed back to an editor as-is. */
export class VariantError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(' | '))
    this.name = 'VariantError'
  }
}

function checkCompiles(rel: string, src: string, errs: string[]): void {
  const dir = mkdtempSync(join(tmpdir(), 'harness-script-'))
  try {
    const file = join(dir, rel.split('/').pop() ?? 'script')
    writeFileSync(file, src)
    const python = rel.endsWith('.py')
    const result = python
      ? spawnSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])', file], { encoding: 'utf8', timeout: 15_000 })
      : spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 15_000 })
    // A missing interpreter is not the variant's fault.
    if (result.error) return
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim().split('\n').filter(Boolean).slice(-2).join(' ')
      errs.push(`${rel} does not compile: ${detail.slice(0, 200)}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Throws a `VariantError` listing every problem; returns a census of a valid variant. */
export function validate(surface: SurfaceSpec, variant: Variant, options: ValidateOptions = {}): VariantCensus {
  const errs: string[] = []
  const r = patterns(surface)
  const cap = options.alwaysOnMax ?? surface.alwaysOnMax
  const body = alwaysOnText(surface, variant)
  if (body.length > cap) errs.push(`always-on content is ${body.length} chars, over the ${cap} cap; ${surface.alwaysOnCapReason}`)

  for (const rel of Object.keys(variant)) {
    if (!isAllowed(surface, rel)) errs.push(`${rel} is not on the editable surface`)
  }

  const skills = skillNames(surface, variant)
  for (const name of skills) {
    const fm = (variant[`${surface.skillDir}/${name}/SKILL.md`] ?? '').slice(0, 600)
    if (!/^description:\s*\S/m.test(fm)) errs.push(`${surface.skillDir}/${name}/SKILL.md needs a \`description:\` in its frontmatter, or the skill is dropped SILENTLY at load`)
    const declared = /^name:\s*(\S+)\s*$/m.exec(fm)?.[1]
    if (surface.skillNameRule === 'must_match') {
      if (declared !== name) errs.push(`${surface.skillDir}/${name}/SKILL.md needs frontmatter \`name: ${name}\` matching its folder (a mismatch is dropped SILENTLY at load)`)
    } else if (declared && declared !== name) {
      errs.push(`${surface.skillDir}/${name}/SKILL.md frontmatter \`name: ${declared}\` overrides the folder name at load, so trigger lines naming \`${name}\` stop matching`)
    }
    if (!body.includes(name)) errs.push(`skill '${name}' is never named in the always-on text, so the agent will not know to invoke it — an untriggered skill is dead weight. ${surface.triggerHint.replaceAll('{name}', name)}`)
  }

  const subagents = subagentNames(surface, variant)
  if (subagents.length && options.allowSubagents === false) errs.push(`subagents are not available here: ${subagents.join(', ')}`)
  for (const name of subagents) {
    const fm = (variant[`${surface.subagentDir}/${name}/AGENT.md`] ?? '').slice(0, 600)
    if (!/^description:\s*\S/m.test(fm)) errs.push(`${surface.subagentDir}/${name}/AGENT.md needs a \`description:\``)
  }

  for (const [rel, src] of Object.entries(variant)) {
    if (options.compileScripts !== false && (r.script.test(rel) || (r.skillScript.test(rel) && /\.(py|mjs)$/.test(rel)))) checkCompiles(rel, src, errs)
    if (r.plugin.test(rel) && !/export\s+default\b/.test(src)) errs.push(`${rel} needs a default export: a Pi extension is a function \`export default function (pi) { ... }\``)
  }

  const reserved = options.reservedScripts ?? RESERVED_SCRIPTS
  const have = new Set(Object.keys(variant).filter((rel) => r.script.test(rel) || r.skillScript.test(rel)))
  for (const [rel, src] of Object.entries(variant)) {
    if (!(r.skill.test(rel) || surface.alwaysOn.includes(rel))) continue
    for (const m of src.matchAll(r.scriptRef)) {
      const ref = m[1]!
      if (reserved.has(ref.split('/').pop()!)) continue
      if (!have.has(ref)) errs.push(`${rel} invokes \`${ref}\` but that file is not in the harness`)
    }
  }

  if (errs.length) throw new VariantError(errs)
  return {
    alwaysOnChars: body.length,
    files: Object.keys(variant).length,
    skills: skills.length,
    subagents: subagents.length,
    scripts: Object.keys(variant).filter((rel) => r.script.test(rel)).length,
    plugins: pluginNames(surface, variant).length
  }
}

export interface VariantDiff {
  added: string[]
  removed: string[]
  modified: string[]
  alwaysOnCharDelta: number
}

export function diffSummary(surface: SurfaceSpec, before: Variant, after: Variant): VariantDiff {
  const a = new Set(Object.keys(before))
  const b = new Set(Object.keys(after))
  return {
    added: [...b].filter((rel) => !a.has(rel)).sort(),
    removed: [...a].filter((rel) => !b.has(rel)).sort(),
    modified: [...a].filter((rel) => b.has(rel) && before[rel] !== after[rel]).sort(),
    alwaysOnCharDelta: alwaysOnText(surface, after).length - alwaysOnText(surface, before).length
  }
}

export function isUnchanged(surface: SurfaceSpec, before: Variant, after: Variant): boolean {
  const d = diffSummary(surface, before, after)
  return !d.added.length && !d.removed.length && !d.modified.length
}

/** Which components a diff touches. */
export function touchedComponents(surface: SurfaceSpec, diff: VariantDiff): ComponentId[] {
  const out = new Set<ComponentId>()
  for (const rel of [...diff.added, ...diff.removed, ...diff.modified]) {
    const id = componentOf(surface, rel)
    if (id) out.add(id)
  }
  return [...out]
}

/** Pairwise line-Jaccard over variants, so a collapse to one body is visible. */
export function diversity(variants: Record<string, Variant>): { n: number; distinct: number; meanLineJaccard: number } {
  const labels = Object.keys(variants).sort()
  if (labels.length < 2) return { n: labels.length, distinct: labels.length, meanLineJaccard: 1 }
  const lines = (variant: Variant) => new Set(Object.entries(variant).flatMap(([rel, text]) => text.split('\n').filter((line) => line.trim()).map((line) => `${rel}:${line}`)))
  const sets = Object.fromEntries(labels.map((label) => [label, lines(variants[label]!)]))
  const sims: number[] = []
  for (let i = 0; i < labels.length; i++) {
    for (const b of labels.slice(i + 1)) {
      const x = sets[labels[i]!]!
      const y = sets[b]!
      const union = new Set([...x, ...y])
      let shared = 0
      for (const line of x) if (y.has(line)) shared++
      sims.push(union.size ? shared / union.size : 1)
    }
  }
  const distinct = new Set(labels.map((label) => JSON.stringify(Object.entries(variants[label]!).sort()))).size
  return { n: labels.length, distinct, meanLineJaccard: Math.round((sims.reduce((sum, value) => sum + value, 0) / sims.length) * 10_000) / 10_000 }
}

/** Applies an omitted-is-inherited edit: `null` removes a file. */
export function applyEdit(base: Variant, edit: Record<string, string | null>): Variant {
  const next: Variant = { ...base }
  for (const [rel, text] of Object.entries(edit)) {
    const clean = normalizeRel(rel)
    if (text === null) delete next[clean]
    else next[clean] = text
  }
  return next
}
