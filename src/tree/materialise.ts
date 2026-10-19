// Turning a harness tree into what a Pi session receives: always-on prompt sections (c1–c4),
// the skills folder Pi advertises natively (c6), the scripts folder named in the prompt (c7),
// subagent definitions (c5), and plugin extensions that are trusted (c8).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { invalid } from '../core/errors'
import * as store from './store'
import { GUARDRAILS, MEMORY, PI_SURFACE, SYSTEM_PROMPT, TOOL_GUIDANCE, patterns, type Tree } from './surface'
import { readTree } from './tree'
import type { TreeTrust } from './trust'

/** Where the tree's own sections sit among the application's (identity 10, role 20). */
export const TREE_SECTION_ORDER = { system: 25, guardrails: 40, memory: 45, subagents: 64, scripts: 66 } as const

/** Which harness a session runs. */
export type HarnessChoice =
  /** A scope's head, or one of its versions. */
  | { scope: string; version?: string | null }
  /** A tree on disk, such as a refinement candidate. It is read, never written. */
  | { dir: string; scope?: string | null }

export interface SubagentDefinition {
  name: string
  description: string
  instructions: string
}

export interface Materialised {
  scope: string | null
  /** The fingerprint of the tree that ran. */
  fingerprint: string
  /** The tree's folder; scripts and skills are read from it in place. */
  dir: string
  tree: Tree
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

/** Finds the tree a choice names. */
export function resolve(root: string, choice: HarnessChoice): { scope: string | null; dir: string; fingerprint: string; tree: Tree } {
  if ('dir' in choice) {
    if (!existsSync(choice.dir)) throw invalid('That harness folder does not exist.')
    const tree = readTree(PI_SURFACE, choice.dir)
    return { scope: choice.scope ?? null, dir: choice.dir, fingerprint: store.fingerprint(tree), tree }
  }
  const fp = choice.version ?? store.head(root, choice.scope)?.fingerprint
  if (!fp) throw invalid(`The harness '${choice.scope}' has no version yet.`)
  const dir = store.versionPath(root, choice.scope, fp)
  return { scope: choice.scope, dir, fingerprint: fp, tree: store.readVersion(root, choice.scope, fp) }
}

export interface MaterialiseOptions {
  trust?: TreeTrust | null
  /** Load improver-written plugin code without trust (refinement probes, when the person allowed it). */
  probeCode?: boolean
  /** Whether the session can start subagents; when it cannot, c5 is not described. */
  subagents?: boolean
}

export function materialise(root: string, choice: HarnessChoice, options: MaterialiseOptions = {}): Materialised {
  const { scope, dir, fingerprint, tree } = resolve(root, choice)
  const r = patterns(PI_SURFACE)
  const sections: Materialised['sections'] = []
  const add = (id: string, title: string, body: string | undefined, order: number) => {
    if (body?.trim()) sections.push({ id, title, body: body.trim(), order })
  }
  add('system', 'Instructions', tree[SYSTEM_PROMPT], TREE_SECTION_ORDER.system)
  add('guardrails', 'Guardrails', tree[GUARDRAILS], TREE_SECTION_ORDER.guardrails)
  add('memory', 'Memory', tree[MEMORY], TREE_SECTION_ORDER.memory)

  const subagents: SubagentDefinition[] = []
  for (const rel of Object.keys(tree).sort()) {
    const m = r.subagent.exec(rel)
    if (!m) continue
    const text = tree[rel]!
    subagents.push({ name: m[1]!, description: frontmatter(text, 'description') ?? '', instructions: bodyAfterFrontmatter(text) })
  }
  if (subagents.length && options.subagents !== false) {
    add('subagents', 'Subagents', `Start one with spawn_subagent and agent set to its name. Each works in its own context and returns text.\n${subagents.map((agent) => `- ${agent.name} — ${agent.description}`).join('\n')}`, TREE_SECTION_ORDER.subagents)
  }

  const scripts = Object.keys(tree).filter((rel) => r.script.test(rel)).map((rel) => rel.slice('scripts/'.length)).sort()
  if (scripts.length) {
    add('scripts', 'Scripts', `Your helper scripts are in ${join(dir, 'scripts')}: ${scripts.join(', ')}. Run a .py one with python3 and a .mjs one with node, giving its full path. When instructions say \`scripts/<name>\`, they mean this folder.`, TREE_SECTION_ORDER.scripts)
  }

  const skillPaths = existsSync(join(dir, 'skills')) && readdirSync(join(dir, 'skills')).length ? [join(dir, 'skills')] : []
  const extensionPaths: string[] = []
  const untrustedPlugins: string[] = []
  for (const rel of Object.keys(tree).filter((path) => r.plugin.test(path)).sort()) {
    const trusted = options.trust?.has((options.trust.review({ [rel]: tree[rel]! })[0]?.hash) ?? '') ?? false
    if (trusted || options.probeCode) extensionPaths.push(join(dir, rel))
    else untrustedPlugins.push(rel)
  }
  return { scope, fingerprint, dir, tree, sections, toolGuidance: (tree[TOOL_GUIDANCE] ?? '').trim(), skillPaths, extensionPaths, untrustedPlugins, subagents }
}

/** One subagent's definition from the tree a run used. */
export function subagentOf(dir: string, name: string): SubagentDefinition | null {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return null
  const path = join(dir, 'sub_agents', name, 'AGENT.md')
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  return { name, description: frontmatter(text, 'description') ?? '', instructions: bodyAfterFrontmatter(text) }
}
