// What Pi would load for a session, found with Pi's own resolver so the list matches Pi's
// rules. Resolving reads folders and manifests; it never runs an extension.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'

import { log } from '../core/bus'
import { packageManifest } from './manifest'

/**
 * `context` is an instruction file Pi reads on its own: `AGENTS.md`, `SYSTEM.md` and their kin.
 * `hook` is a package's hooks file, which the harness runs itself; Pi never loads it.
 */
export type FoundKind = 'extension' | 'skill' | 'prompt' | 'theme' | 'context' | 'hook'

/** Where a found item comes from. `builtin` is one of the Pi command's own extensions. */
export type FoundOrigin = 'shared' | 'package' | 'project' | 'home' | 'builtin'

export interface Found {
  kind: FoundKind
  /** A file or folder, or `builtin:<name>`. */
  path: string
  origin: FoundOrigin
  /** Declared by the working folder: its `.pi` or `.agents` folder, or its settings. */
  project: boolean
  /** The folder of the package this belongs to. */
  packageRoot: string | null
  /** The package as its settings name it (`npm:…`, `git:…`, a folder). */
  source: string | null
  /** Left on in Pi's settings. An item switched off there is found but never loaded. */
  enabled: boolean
}

export interface ResolveInput {
  cwd: string
  /** The account's Pi agent folder. */
  agentDir: string
  /** Install a package the shared settings name and the account does not have yet. */
  install?: boolean
  /** Folders of packages kept outside Pi's settings: each is found as an installed package. */
  packages?: readonly string[]
}

/** Finds what Pi would load. Replaced in tests. */
export type Resolver = (input: ResolveInput) => Promise<Found[]>

/** The extensions built into the `pi` command. A terminal loads them; an SDK session has none. */
export const PI_BUILTINS = ['llama.cpp', 'codemode', 'tool-search', 'mcp'] as const
export const BUILTIN_PREFIX = 'builtin:'

const inside = (path: string, parent: string): boolean => path === parent || path.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)

interface Metadata {
  source: string
  scope: string
  origin: string
  baseDir?: string
  packageRoot?: string
}

function origin(path: string, metadata: Metadata): FoundOrigin {
  if (path.startsWith(BUILTIN_PREFIX)) return 'builtin'
  if (metadata.origin === 'package') return 'package'
  if (metadata.scope === 'project') return 'project'
  return metadata.baseDir && inside(metadata.baseDir, join(process.env.HOME || homedir(), '.agents')) ? 'home' : 'shared'
}

/**
 * Runs an install with the package manager's install scripts switched off, so fetching a
 * package runs none of its code. A package that builds itself on install then fails to load,
 * and says so; that is the price of installing being safe to do before trust.
 */
export async function withoutInstallScripts<T>(action: () => Promise<T>): Promise<T> {
  const before = process.env.npm_config_ignore_scripts
  process.env.npm_config_ignore_scripts = 'true'
  try {
    return await action()
  } finally {
    if (before === undefined) delete process.env.npm_config_ignore_scripts
    else process.env.npm_config_ignore_scripts = before
  }
}

export const piResolver: Resolver = async ({ cwd, agentDir, install, packages }) => {
  const pi = await import('@earendil-works/pi-coding-agent')
  const settings = pi.SettingsManager.create(cwd, agentDir)
  const shared = new Set((settings.getGlobalSettings().packages ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.source)))
  const manager = (): InstanceType<typeof pi.DefaultPackageManager> => new pi.DefaultPackageManager({ cwd, agentDir, settingsManager: settings, builtinExtensions: [...PI_BUILTINS] })
  const resolve = (installing: boolean) => manager().resolve(async (source) => (installing && shared.has(source) ? 'install' : 'skip'))
  let resolved: Awaited<ReturnType<typeof resolve>>
  try {
    resolved = install ? await withoutInstallScripts(() => resolve(true)) : await resolve(false)
  } catch (error) {
    if (!install) throw error
    // A package that cannot be installed must not stop the session; it is found again next time.
    log('a plugin package could not be installed', error instanceof Error ? error.message : String(error))
    resolved = await resolve(false)
  }
  const found: Found[] = []
  const add = (paths: typeof resolved): void => {
    const kinds = [['extension', paths.extensions], ['skill', paths.skills], ['prompt', paths.prompts], ['theme', paths.themes]] as const
    for (const [kind, resources] of kinds) {
      for (const resource of resources) {
        const metadata = resource.metadata as Metadata
        const packaged = metadata.origin === 'package'
        found.push({
          kind,
          path: resource.path,
          origin: origin(resource.path, metadata),
          project: metadata.scope === 'project',
          packageRoot: packaged ? (metadata.packageRoot ?? metadata.baseDir ?? null) : null,
          source: packaged ? metadata.source : null,
          enabled: resource.enabled
        })
      }
    }
  }
  add(resolved)
  // Packages a person keeps beside their data are read where they are; nothing is fetched for them.
  if (packages?.length) {
    try {
      add(await manager().resolveExtensionSources([...packages]))
    } catch (error) {
      log('a local plugin could not be read', error instanceof Error ? error.message : String(error))
    }
  }
  // A package may name a hooks file for the harness. Only a package a person installed counts:
  // a working folder's package cannot put code into the harness's own process.
  const roots = new Map<string, string>()
  for (const configured of manager().listConfiguredPackages()) if (configured.scope === 'user' && configured.installedPath) roots.set(configured.installedPath, configured.source)
  for (const folder of packages ?? []) roots.set(folder, folder)
  for (const [root, source] of roots) {
    const hooks = packageManifest(root).hooks
    if (!hooks || !existsSync(join(root, hooks))) continue
    found.push({ kind: 'hook', path: join(root, hooks), origin: 'package', project: false, packageRoot: root, source, enabled: true })
    // Pi takes a folder with none of its own resources to be an extension itself. A package that
    // only brings hooks is not one, and must not be handed to Pi as code to load.
    const fallback = found.findIndex((item) => item.kind === 'extension' && item.path === root)
    if (fallback !== -1) found.splice(fallback, 1)
  }
  // Pi reads these itself, whatever else is switched off. They are text, so they are only listed.
  const context = [
    ...pi.loadProjectContextFiles({ cwd, agentDir }).map((file) => file.path),
    ...[join(agentDir, 'SYSTEM.md'), join(agentDir, 'APPEND_SYSTEM.md'), join(cwd, '.pi', 'SYSTEM.md'), join(cwd, '.pi', 'APPEND_SYSTEM.md')].filter((path) => existsSync(path))
  ]
  for (const path of context) {
    const shared = inside(path, agentDir)
    found.push({ kind: 'context', path, origin: shared ? 'shared' : 'project', project: !shared, packageRoot: null, source: null, enabled: true })
  }
  return found
}
