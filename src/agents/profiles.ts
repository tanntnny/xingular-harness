// Agent profiles (PROP-0029): named bundles a subagent starts from, with its instructions, colour,
// tools, plugins, variant, model and effort. They come from four places, later ones winning:
// built-ins in code, `<data root>/agents/*.md`, `<project>/.xingular/agents/*.md`; a variant's own
// c5 subagents fill in names nobody else took. Profiles only narrow what the parent has.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { EFFORTS, type Effort } from '../core/effort'
import { invalid, notFound } from '../core/errors'
import { parse, serialize } from '../core/frontmatter'
import { atomicWrite } from '../core/fs'
import { subagentOf } from '../variant/materialise'
import { BUILTIN_PROFILES } from './builtin'

export const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]*$/
export const PROFILE_COLORS = ['blue', 'green', 'yellow', 'red', 'magenta', 'cyan', 'orange', 'purple'] as const
export type ProfileColor = (typeof PROFILE_COLORS)[number]
export type ProfileSource = 'builtin' | 'global' | 'project' | 'variant'
/** Where a person's own profile file lives. */
export type ProfileScope = 'global' | 'project'

/** Which variant a profile's subagent runs: a scope's head or version, none, or the parent's (null). */
export type ProfileVariant = { scope: string; version: string | null } | 'none' | null

export interface AgentProfile {
  name: string
  description: string
  color: ProfileColor
  /** The role instructions: the file's body. */
  instructions: string
  /** Tool allowlist; null keeps every tool the parent has. */
  tools: string[] | null
  /** Plugin ids whose contributions the subagent keeps; null keeps all. Required plugins always stay. */
  plugins: string[] | null
  variant: ProfileVariant
  model: string | null
  effort: Effort | null
  source: ProfileSource
  /** The file it was read from; null for built-ins. */
  path: string | null
}

export interface ProfileProblem {
  name: string
  source: ProfileSource
  path: string
  error: string
}

export interface ProfileListing {
  profiles: AgentProfile[]
  problems: ProfileProblem[]
}

/** The built-in profile definitions, before a source is attached. */
export type ProfileDefinition = Omit<AgentProfile, 'source' | 'path'>

/** Nearest folder above `cwd` that holds `.git`, or `cwd` itself. */
export function projectRoot(cwd: string): string {
  let dir = cwd
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return cwd
    dir = parent
  }
}

export function profileDirs(root: string, cwd?: string | null): { global: string; project: string | null } {
  return { global: join(root, 'agents'), project: cwd ? join(projectRoot(cwd), '.xingular', 'agents') : null }
}

function stringList(value: unknown, field: string): string[] | null {
  if (value === undefined || value === null) return null
  const list = typeof value === 'string' ? value.split(/[\s,]+/u) : value
  if (!Array.isArray(list) || list.some(item => typeof item !== 'string')) throw invalid(`${field} must be a list of names.`)
  return [...new Set((list as string[]).map(item => item.trim()).filter(Boolean))]
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw invalid(`${field} must be text.`)
  return value.trim() || null
}

export function parseVariant(value: unknown): ProfileVariant {
  const text = optionalText(value, 'variant')
  if (!text) return null
  if (text === 'none') return 'none'
  const [scope, version, ...rest] = text.split('@')
  if (!scope || rest.length || (version !== undefined && !version)) throw invalid('variant must be <scope>, <scope>@<version> or none.')
  return { scope, version: version ?? null }
}

export function formatVariant(variant: ProfileVariant): string | null {
  if (!variant) return null
  if (variant === 'none') return 'none'
  return variant.version ? `${variant.scope}@${variant.version}` : variant.scope
}

/** Reads one profile file. Throws an `invalid_request` error that names what is wrong. */
export function parseProfile(text: string, name: string, source: ProfileSource, path: string | null): AgentProfile {
  if (!PROFILE_NAME.test(name)) throw invalid('A profile name uses lowercase letters, digits, - and _, and starts with a letter or digit.')
  const parsed = parse(text)
  if (!parsed) throw invalid('The profile needs a frontmatter block between --- lines.')
  const front = parsed.front
  if (front.name !== undefined && front.name !== name) throw invalid(`The file is named ${name} but its frontmatter says ${String(front.name)}.`)
  const description = optionalText(front.description, 'description')
  if (!description) throw invalid('The profile needs a description.')
  const color = optionalText(front.color, 'color') ?? 'blue'
  if (!(PROFILE_COLORS as readonly string[]).includes(color)) throw invalid(`color must be one of ${PROFILE_COLORS.join(', ')}.`)
  const effort = optionalText(front.effort, 'effort')
  if (effort && !(EFFORTS as readonly string[]).includes(effort)) throw invalid(`effort must be one of ${EFFORTS.join(', ')}.`)
  return {
    name, description, color: color as ProfileColor, instructions: parsed.body.trim(),
    tools: stringList(front.tools, 'tools'), plugins: stringList(front.plugins, 'plugins'),
    variant: parseVariant(front.variant), model: optionalText(front.model, 'model'), effort: effort as Effort | null,
    source, path
  }
}

/** The file text for a profile, as `createProfile` writes it. */
export function profileText(profile: ProfileDefinition): string {
  const front: Record<string, unknown> = { name: profile.name, description: profile.description, color: profile.color }
  if (profile.tools) front.tools = profile.tools
  if (profile.plugins) front.plugins = profile.plugins
  const variant = formatVariant(profile.variant)
  if (variant) front.variant = variant
  if (profile.model) front.model = profile.model
  if (profile.effort) front.effort = profile.effort
  return serialize(front, profile.instructions)
}

function readFolder(dir: string | null, source: ProfileSource, into: Map<string, AgentProfile>, problems: ProfileProblem[]): void {
  if (!dir || !existsSync(dir)) return
  for (const file of readdirSync(dir).filter(entry => entry.endsWith('.md')).sort()) {
    const path = join(dir, file)
    const name = file.slice(0, -3)
    try {
      if (!statSync(path).isFile()) continue
      into.set(name, parseProfile(readFileSync(path, 'utf8'), name, source, path))
    } catch (error) {
      problems.push({ name, source, path, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

function variantDefinitions(variantDir: string | null | undefined): AgentProfile[] {
  const folder = variantDir ? join(variantDir, 'sub_agents') : null
  if (!folder || !existsSync(folder)) return []
  return readdirSync(folder).sort().flatMap(name => {
    const definition = subagentOf(variantDir!, name)
    if (!definition) return []
    return [{
      name, description: definition.description || name, color: 'blue' as const, instructions: definition.instructions || definition.description,
      tools: null, plugins: null, variant: null, model: null, effort: null,
      source: 'variant' as const, path: join(folder, name, 'AGENT.md')
    }]
  })
}

/**
 * Every profile a session in `cwd` can use. An unreadable file is reported in `problems`; it hides
 * nothing, so a broken project file leaves the global or built-in profile of that name in force.
 */
export function listProfiles(root: string, cwd?: string | null, variantDir?: string | null): ProfileListing {
  const profiles = new Map<string, AgentProfile>()
  const problems: ProfileProblem[] = []
  for (const definition of BUILTIN_PROFILES) profiles.set(definition.name, { ...definition, source: 'builtin', path: null })
  const dirs = profileDirs(root, cwd)
  readFolder(dirs.global, 'global', profiles, problems)
  readFolder(dirs.project, 'project', profiles, problems)
  for (const definition of variantDefinitions(variantDir)) if (!profiles.has(definition.name)) profiles.set(definition.name, definition)
  return { profiles: [...profiles.values()].sort((left, right) => left.name.localeCompare(right.name)), problems }
}

export function resolveProfile(root: string, cwd: string | null | undefined, name: string, variantDir?: string | null): AgentProfile | null {
  if (!PROFILE_NAME.test(name)) return null
  return listProfiles(root, cwd, variantDir).profiles.find(profile => profile.name === name) ?? null
}

function scopeDir(root: string, cwd: string | null | undefined, scope: ProfileScope): string {
  const dirs = profileDirs(root, cwd)
  if (scope === 'global') return dirs.global
  if (!dirs.project) throw invalid('A project profile needs a working folder.')
  return dirs.project
}

const TEMPLATE: Omit<ProfileDefinition, 'name'> = {
  description: 'What this agent is for, in one line.',
  color: 'blue',
  instructions: 'Describe how this agent should work: what to do with a brief, what to avoid, and what to report back.',
  tools: null, plugins: null, variant: null, model: null, effort: null
}

/** Writes a new profile file from the template, or a copy of `from`. Refuses to overwrite one. */
export function createProfile(root: string, cwd: string | null | undefined, input: { name: string; scope: ProfileScope; from?: string | null }): AgentProfile {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!PROFILE_NAME.test(name)) throw invalid('A profile name uses lowercase letters, digits, - and _, and starts with a letter or digit.')
  if (input.scope !== 'global' && input.scope !== 'project') throw invalid('scope must be global or project.')
  const dir = scopeDir(root, cwd, input.scope)
  const path = join(dir, `${name}.md`)
  if (existsSync(path)) throw invalid(`There is already a ${input.scope} profile named ${name}.`)
  let source: ProfileDefinition = { ...TEMPLATE, name }
  if (input.from) {
    const original = resolveProfile(root, cwd, input.from)
    if (!original) throw notFound(`The profile ${input.from}`)
    source = { ...original, name }
  }
  mkdirSync(dir, { recursive: true })
  const text = profileText(source)
  atomicWrite(path, text)
  return parseProfile(text, name, input.scope, path)
}

/** Deletes a person's own profile file. Built-ins and variant subagents cannot be removed here. */
export function removeProfile(root: string, cwd: string | null | undefined, input: { name: string; scope: ProfileScope }): void {
  if (!PROFILE_NAME.test(input.name)) throw invalid('That is not a profile name.')
  if (input.scope !== 'global' && input.scope !== 'project') throw invalid('scope must be global or project.')
  const path = join(scopeDir(root, cwd, input.scope), `${input.name}.md`)
  if (!existsSync(path)) throw notFound(`The ${input.scope} profile ${input.name}`)
  rmSync(path)
}

/** Where the profile list sits among the prompt sections: the slot a variant's subagents used. */
export const PROFILE_SECTION_ORDER = 64

/** The prompt section that lists the profiles a run can start subagents from. */
export function profileSection(root: string, cwd: string | null | undefined, variantDir?: string | null): { id: string; title: string; body: string; budget: number; order: number } {
  const { profiles } = listProfiles(root, cwd, variantDir)
  return {
    id: 'subagents',
    title: 'Subagents',
    body: [
      'Start one with spawn_subagent and agent set to a profile name, or omit agent for a copy of yourself. Each works in its own context with a complete brief from you, keeps its own checklist the user can follow, and returns text. A profile can only narrow your tools.',
      ...profiles.map((profile) => `- ${profile.name} — ${profile.description}`)
    ].join('\n'),
    budget: 6_000,
    order: PROFILE_SECTION_ORDER
  }
}
