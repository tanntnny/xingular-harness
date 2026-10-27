// The harness decides what a Pi session loads. Pi's own discovery is switched off for sessions
// and terminals; they receive the paths chosen here, so nothing reaches a model unlisted.
import { chmodSync, lstatSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import type { Bus } from '../core/bus'
import { now, readJsonOr, writeJson } from '../core/fs'
import { attached, type Attachments, type AttachScope } from './attachments'
import { piResolver, type Found, type ResolveInput, type Resolver } from './discover'
import { foundIds, pluginIdOf } from './identity'
import { packageCode, projectCode, Trust, type ProjectCode } from './trust'

/** What one session or terminal loads besides the registry's own items. */
export interface Loading {
  /** Extension files and folders, in the order Pi would have loaded them. */
  extensionPaths: string[]
  skillPaths: string[]
  promptPaths: string[]
  themePaths: string[]
  /** Subagent profile files packages bring. The harness reads them; Pi is never given them. */
  profilePaths: string[]
  /** The `pi` command's own extensions left on, as `builtin:<name>`. Only a terminal has them. */
  builtins: string[]
  /** Hooks files the harness runs itself. Pi is never given them. */
  hooks: { path: string; packageRoot: string; hash: string }[]
  /** Everything found, loaded or not. */
  found: Found[]
  /** Paths of found items a person switched off for this caller. */
  detached: string[]
  /** Applies the same attachment policy to resources supplied by a trusted extension. */
  resourceAllowed?: (item: Found) => boolean
  /** Code the working folder brings, and whether a person trusted it. */
  projectCode: (ProjectCode & { trusted: boolean }) | null
  /** Each installed package that brings code, by its folder, and whether a person trusted it. */
  packageCode: Record<string, ProjectCode & { trusted: boolean }>
}

/** What one loaded extension added to a session. */
export interface Registered {
  path: string
  hooks: string[]
  tools: string[]
  commands: string[]
  flags: string[]
  shortcuts: string[]
  /** Fingerprint at observation time; stale registrations are not presented as current. */
  hash?: string | null
  seenAt?: string
  resources?: RuntimeResource[]
}

export interface RuntimeResource {
  kind: 'skill' | 'command' | 'theme'
  name: string
  path: string
  chars: number | null
}

export interface PluginsOptions {
  stateDir: string
  bus: Bus
  resolver?: Resolver
  /** The choices a person made about what is switched on, or `null` while there is no data root. */
  attachments?: () => Attachments | null
  /** The folder of packages kept with a person's data, or `null` while there is no data root. */
  packagesDir?: () => string | null
}

/** The package folders inside a folder: each direct child that is a folder and not hidden. */
export function packageFolders(directory: string | null): string[] {
  if (!directory) return []
  try {
    return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => join(directory, entry.name)).sort()
  } catch {
    return []
  }
}

export interface LoadingInput extends ResolveInput {
  /** Who the session is for. Something switched off for this agent or project does not load. */
  caller?: AttachScope
  /** The contributions frozen for a run. When present, this snapshot governs loading. */
  contributions?: readonly string[]
}

/** Which code a person trusted: the working folder's as a whole, and each installed package's. */
export interface Trusted {
  project: boolean
  /** Folders of installed packages whose code is not trusted. */
  untrustedPackages: ReadonlySet<string>
}

export const trustedBy = (loading: Pick<Loading, 'projectCode' | 'packageCode'> | null): Trusted => ({
  project: !!loading?.projectCode?.trusted,
  untrustedPackages: new Set(Object.entries(loading?.packageCode ?? {}).filter(([, code]) => !code.trusted).map(([root]) => root))
})

/**
 * Whether a found item loads: it is on in Pi's settings, and if it is code, a person trusted it.
 * A loose file in the shared folder was put there by hand and needs no trust. Text always loads.
 */
export function loads(item: Found, trusted: Trusted): boolean {
  if (!item.enabled) return false
  if (item.kind !== 'extension' && item.kind !== 'hook') return true
  if (item.project) return trusted.project
  return !(item.packageRoot && trusted.untrustedPackages.has(item.packageRoot))
}

/**
 * Whether a person left a found item switched on for a caller. Pi reads its instruction files
 * itself and its command owns its built-in extensions, so neither can be switched off here.
 */
export function switchable(item: Found): boolean {
  return item.kind !== 'context' && item.origin !== 'builtin'
}

export class Plugins {
  readonly trust: Trust
  private readonly resolver: Resolver
  private readonly registeredPath: string

  constructor(private readonly options: PluginsOptions) {
    this.trust = new Trust(options.stateDir, options.bus)
    this.resolver = options.resolver ?? piResolver
    this.registeredPath = join(options.stateDir, 'plugin-registered.json')
  }

  /** Finds what Pi would load in this folder, and chooses what does. */
  async loading(input: LoadingInput): Promise<Loading> {
    // Links an earlier version put in the shared skills folder would be found as skills again.
    removeLinkedSkills(join(input.agentDir, 'skills'))
    const found = await this.resolver({ ...input, packages: packageFolders(this.options.packagesDir?.() ?? null) })
    const code = projectCode(found, input.cwd)
    const packages = packageCode(found)
    // Packages that loaded before trust was asked per package keep loading: they are taken over once.
    if (!this.trust.adopted) this.trust.adopt([...packages].map(([folder, packaged]) => ({ code: packaged, folder })))
    const trustedHashes = new Set(this.trust.list().map((record) => record.hash))
    const projectCodeState = code ? { ...code, trusted: trustedHashes.has(code.hash) } : null
    const packageCodeState = Object.fromEntries([...packages].map(([folder, packaged]) => [folder, { ...packaged, trusted: trustedHashes.has(packaged.hash) }]))
    const trusted = trustedBy({ projectCode: projectCodeState, packageCode: packageCodeState })
    const choices = this.options.attachments?.() ?? null
    const off = (item: Found): boolean => {
      if (!choices || !switchable(item)) return false
      // A hook runs for everyone or not at all, so only its plugin's switch for everyone counts.
      if (item.kind === 'hook') return !attached(choices, [pluginIdOf(item)], {}, true)
      return !attached(choices, foundIds(item), input.caller ?? {}, true)
    }
    const allowed = (item: Found): boolean => input.contributions === undefined
      ? !off(item)
      : input.contributions.includes(foundIds(item)[0])
    const detached = found.filter((item) => !allowed(item)).map((item) => item.path)
    const chosen = found.filter((item) => loads(item, trusted) && allowed(item))
    const paths = (kind: Found['kind'], builtin: boolean): string[] => chosen.filter((item) => item.kind === kind && (item.origin === 'builtin') === builtin).map((item) => item.path)
    return {
      extensionPaths: paths('extension', false),
      skillPaths: paths('skill', false),
      promptPaths: paths('prompt', false),
      themePaths: paths('theme', false),
      profilePaths: paths('agent', false),
      builtins: paths('extension', true),
      hooks: chosen.filter((item) => item.kind === 'hook' && item.packageRoot).map((item) => ({ path: item.path, packageRoot: item.packageRoot!, hash: packageCodeState[item.packageRoot!]?.hash ?? '' })),
      found,
      detached,
      resourceAllowed: allowed,
      projectCode: projectCodeState,
      packageCode: packageCodeState
    }
  }

  /** What each extension registered the last time a session loaded it. */
  registered(): Record<string, Registered & { seenAt: string }> {
    return readJsonOr<Record<string, Registered & { seenAt: string }>>(this.registeredPath, {})
  }

  /** Records what a session's extensions registered, so the list can show it without loading code. */
  loaded(extensions: readonly Registered[]): void {
    if (!extensions.length) return
    const stored = this.registered()
    let changed = false
    for (const extension of extensions) {
      const { seenAt: _seenAt, ...before } = stored[extension.path] ?? ({} as Registered & { seenAt: string })
      if (JSON.stringify(before) === JSON.stringify(extension)) continue
      stored[extension.path] = { ...extension, seenAt: now() }
      changed = true
    }
    if (!changed) return
    writeJson(this.registeredPath, stored)
    chmodSync(this.registeredPath, 0o600)
    this.options.bus.emit({ type: 'plugins.changed' })
  }
}

// Prefix of the entries an earlier version of the harness linked into a Pi agent folder's `skills/`.
const LINKED_SKILL_PREFIX = 'agentx-'

function isLinkedSkill(path: string): boolean {
  let meta
  try {
    meta = lstatSync(path)
  } catch {
    return false
  }
  if (meta.isSymbolicLink()) return true
  if (!meta.isDirectory()) return false
  // A single-file skill was linked as `agentx-<name>/SKILL.md` inside a folder the harness made.
  try {
    const entries = readdirSync(path)
    return entries.length === 1 && entries[0] === 'SKILL.md' && lstatSync(join(path, 'SKILL.md')).isSymbolicLink()
  } catch {
    return false
  }
}

/** Removes the skill links an earlier version of the harness kept in a Pi agent folder's `skills/`. */
export function removeLinkedSkills(skillsDir: string): void {
  let names: string[]
  try {
    names = readdirSync(skillsDir)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(skillsDir, name)
    if (!name.startsWith(LINKED_SKILL_PREFIX) || !isLinkedSkill(path)) continue
    if (lstatSync(path).isSymbolicLink()) unlinkSync(path)
    else rmSync(path, { recursive: true, force: true })
  }
}
