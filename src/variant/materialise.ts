// Turning a variant into what a Pi session receives: always-on prompt sections (c1–c4),
// the skills folder Pi advertises natively (c6), the scripts folder named in the prompt (c7),
// subagent definitions (c5), and plugin extensions that are trusted (c8).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { invalid } from '../core/errors'
import * as store from './store'
import { GUARDRAILS, MEMORY, PI_SURFACE, SYSTEM_PROMPT, TOOL_GUIDANCE, patterns, type Variant } from './surface'
import { readVariant } from './variant'
import type { VariantTrust } from './trust'

/** Where the variant's own sections sit among the application's (identity 10, role 20). */
export const VARIANT_SECTION_ORDER = { system: 25, guardrails: 40, memory: 45, subagents: 64, scripts: 66 } as const

/** Which variant a session runs. */
export type VariantChoice =
  /** A scope's head, or one of its versions. */
  | { scope: string; version?: string | null }
  /** A variant on disk, such as a refinement candidate. It is read, never written. */
  | { dir: string; scope?: string | null }

export interface SubagentDefinition {
  name: string
  description: string
  instructions: string
}

export interface Materialised {
  scope: string | null
  /** The fingerprint of the variant that ran. */
  fingerprint: string
  /** The variant's folder; scripts and skills are read from it in place. */
  dir: string
  /** The variant's files, path → text. */
  files: Variant
  sections: { id: string; title: string; body: string; order: number }[]
  /** The tool guidance, added after the tool groups. */
  toolGuidance: string
  skillPaths: string[]
  extensionPaths: string[]
  /** Plugin files that did not load because their code is not trusted. */
  untrustedPlugins: string[]
  subagents: SubagentDefinition[]
}

function frontmatter(text: string, field: string): string | null {
  const m = new RegExp(`^${field}:\\s*(.+)$`, 'm').exec(text.slice(0, 600))
  return m?.[1]?.trim() ?? null
}

function bodyAfterFrontmatter(text: string): string {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(text)
  return (m ? text.slice(m[0].length) : text).trim()
}

/** Finds the variant a choice names. */
export function resolve(root: string, choice: VariantChoice): { scope: string | null; dir: string; fingerprint: string; variant: Variant } {
  if ('dir' in choice) {
    if (!existsSync(choice.dir)) throw invalid('That variant folder does not exist.')
    const variant = readVariant(PI_SURFACE, choice.dir)
    return { scope: choice.scope ?? null, dir: choice.dir, fingerprint: store.fingerprint(variant), variant }
  }
  const fp = choice.version ?? store.head(root, choice.scope)?.fingerprint
  if (!fp) throw invalid(`The variant '${choice.scope}' has no version yet.`)
  const dir = store.versionPath(root, choice.scope, fp)
  return { scope: choice.scope, dir, fingerprint: fp, variant: store.readVersion(root, choice.scope, fp) }
}

export interface MaterialiseOptions {
  trust?: VariantTrust | null
  /** Load improver-written plugin code without trust (refinement probes, when the person allowed it). */
  probeCode?: boolean
  /** Whether the session can start subagents; when it cannot, c5 is not described. */
  subagents?: boolean
}

export function materialise(root: string, choice: VariantChoice, options: MaterialiseOptions = {}): Materialised {
  const { scope, dir, fingerprint, variant } = resolve(root, choice)
  const r = patterns(PI_SURFACE)
  const sections: Materialised['sections'] = []
  const add = (id: string, title: string, body: string | undefined, order: number) => {
    if (body?.trim()) sections.push({ id, title, body: body.trim(), order })
  }
  add('system', 'Instructions', variant[SYSTEM_PROMPT], VARIANT_SECTION_ORDER.system)
  add('guardrails', 'Guardrails', variant[GUARDRAILS], VARIANT_SECTION_ORDER.guardrails)
  add('memory', 'Memory', variant[MEMORY], VARIANT_SECTION_ORDER.memory)

  const subagents: SubagentDefinition[] = []
  for (const rel of Object.keys(variant).sort()) {
    const m = r.subagent.exec(rel)
    if (!m) continue
    const text = variant[rel]!
    subagents.push({ name: m[1]!, description: frontmatter(text, 'description') ?? '', instructions: bodyAfterFrontmatter(text) })
  }
  if (subagents.length && options.subagents !== false) {
    add('subagents', 'Subagents', `Start one with spawn_subagent and agent set to its name. Each works in its own context and returns text.\n${subagents.map((agent) => `- ${agent.name} — ${agent.description}`).join('\n')}`, VARIANT_SECTION_ORDER.subagents)
  }

  const scripts = Object.keys(variant).filter((rel) => r.script.test(rel)).map((rel) => rel.slice('scripts/'.length)).sort()
  if (scripts.length) {
    add('scripts', 'Scripts', `Your helper scripts are in ${join(dir, 'scripts')}: ${scripts.join(', ')}. Run a .py one with python3 and a .mjs one with node, giving its full path. When instructions say \`scripts/<name>\`, they mean this folder.`, VARIANT_SECTION_ORDER.scripts)
  }

  const skillPaths = existsSync(join(dir, 'skills')) && readdirSync(join(dir, 'skills')).length ? [join(dir, 'skills')] : []
  const extensionPaths: string[] = []
  const untrustedPlugins: string[] = []
  for (const rel of Object.keys(variant).filter((path) => r.plugin.test(path)).sort()) {
    const trusted = options.trust?.has((options.trust.review({ [rel]: variant[rel]! })[0]?.hash) ?? '') ?? false
    if (trusted || options.probeCode) extensionPaths.push(join(dir, rel))
    else untrustedPlugins.push(rel)
  }
  return { scope, fingerprint, dir, files: variant, sections, toolGuidance: (variant[TOOL_GUIDANCE] ?? '').trim(), skillPaths, extensionPaths, untrustedPlugins, subagents }
}

/** One subagent's definition from the variant a run used. */
export function subagentOf(dir: string, name: string): SubagentDefinition | null {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return null
  const path = join(dir, 'sub_agents', name, 'AGENT.md')
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  return { name, description: frontmatter(text, 'description') ?? '', instructions: bodyAfterFrontmatter(text) }
}
