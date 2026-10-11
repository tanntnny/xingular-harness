// Isolated launch environments. Every Pi session the harness starts gets its account's own
// agent folder (`PI_CODING_AGENT_DIR`) under the state directory, and inherited credential
// variables are removed. A launch that would fall back to `~/.pi` is refused.
//
// Settings, skills, prompts, and instructions are shared by every account: the account's agent
// folder links those entries to `_shared/pi/`. Credentials, sessions, and history stay in the
// account's own folder.
import { chmodSync, lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'

import { HarnessError } from '../core/errors'
import type { Account } from './store'

// Config-directory variables the harness always sets itself, including those of other tools so
// a session can never inherit them.
const DIR_VARS = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR']

/** Inherited variables that carry credentials; they would bypass the account's own sign-in. */
export function isCredentialVar(name: string): boolean {
  const upper = name.toUpperCase()
  return DIR_VARS.includes(upper) || ['_API_KEY', '_AUTH_TOKEN', '_OAUTH_TOKEN', '_ACCESS_TOKEN'].some((suffix) => upper.endsWith(suffix))
}

/** Names of inherited variables to remove from a session's process. */
export function inheritedCredentialVars(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = Object.keys(env).filter(isCredentialVar)
  for (const name of DIR_VARS) if (!names.includes(name)) names.push(name)
  return names
}

/**
 * Makes this process safe to run Pi sessions in: credentials come only from an account's own
 * store, so inherited credential variables are dropped, and Pi's fallback agent folder is an
 * empty one under the state directory rather than `~/.pi`.
 */
export function isolateProcess(accountsDir: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const name of inheritedCredentialVars(env)) delete env[name]
  const fallback = join(accountsDir, '.sidecar', 'pi')
  mkdirSync(fallback, { recursive: true })
  env.PI_CODING_AGENT_DIR = fallback
}

export const homeDir = (accountsDir: string, accountId: string): string => join(accountsDir, accountId, 'home')
/** Pi's agent folder for this account. */
export const configDir = (accountsDir: string, account: Pick<Account, 'id'>): string => join(homeDir(accountsDir, account.id), 'pi')
/** The agent-folder entries every account shares. */
export const sharedDir = (accountsDir: string): string => join(accountsDir, '_shared', 'pi')

function makePrivate(path: string): void {
  mkdirSync(path, { recursive: true })
  chmodSync(path, 0o700)
}

// Entries every account shares, and whether each is a folder. Credentials (`auth.json`),
// sessions, and history are never listed.
const SHARED_ENTRIES: readonly (readonly [string, boolean])[] = [
  ['settings.json', false],
  ['models.json', false],
  ['AGENTS.md', false],
  ['SYSTEM.md', false],
  ['skills', true],
  ['prompts', true],
  ['extensions', true],
  ['themes', true]
]

export interface NativeConfig {
  provider: string
  path: string
  entries: { name: string; directory: boolean; present: boolean }[]
}

const present = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** What the accounts share, and which of it exists yet. Reads only; nothing is created. */
export function nativeConfig(accountsDir: string): NativeConfig {
  const shared = sharedDir(accountsDir)
  return { provider: 'pi', path: shared, entries: SHARED_ENTRIES.map(([name, directory]) => ({ name, directory, present: present(join(shared, name)) })) }
}

/** The shared folder, created private if no account has linked it yet. */
export function ensureSharedDir(accountsDir: string): string {
  const shared = sharedDir(accountsDir)
  makePrivate(shared)
  return shared
}

const modified = (path: string): number => {
  try {
    return lstatSync(path).mtimeMs
  } catch {
    return -1
  }
}

/** Moves a real file or folder aside so the shared link can take its place. */
function backUp(path: string): void {
  renameSync(path, join(dirname(path), `${basename(path)}.agentx-backup-${Math.floor(Date.now() / 1000)}`))
}

/**
 * Links the account's shared entries to `_shared/pi/`. A real entry found in the account folder
 * (from before sharing, or a tool that replaced the link while saving) becomes the shared copy
 * when there is none or it is newer; otherwise it is kept as a backup.
 */
function linkShared(accountsDir: string, dir: string): void {
  const shared = ensureSharedDir(accountsDir)
  for (const [name, isDir] of SHARED_ENTRIES) {
    const local = join(dir, name)
    const target = join(shared, name)
    let meta: ReturnType<typeof lstatSync> | null = null
    try {
      meta = lstatSync(local)
    } catch {
      meta = null
    }
    if (meta?.isSymbolicLink()) {
      if (readlinkSync(local) === target) {
        if (isDir) mkdirSync(target, { recursive: true })
        continue
      }
      unlinkSync(local)
    } else if (meta) {
      if (!present(target)) renameSync(local, target)
      else if (!isDir && modified(local) > modified(target)) {
        backUp(target)
        renameSync(local, target)
      } else backUp(local)
    }
    if (isDir) mkdirSync(target, { recursive: true })
    symlinkSync(target, local)
  }
}

/** Creates the account's runtime folder and links the shared entries into it. */
export function ensureHome(accountsDir: string, account: Pick<Account, 'id'>): string {
  makePrivate(join(accountsDir, account.id))
  makePrivate(homeDir(accountsDir, account.id))
  const dir = configDir(accountsDir, account)
  makePrivate(dir)
  linkShared(accountsDir, dir)
  return dir
}

const inside = (path: string, parent: string): boolean => path === parent || path.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)

/**
 * Refuses an agent folder that is (or is inside) a default tool folder, or that is not inside
 * the harness's own accounts folder.
 */
export function assertIsolated(accountsDir: string, dir: string): void {
  const defaults = ['.codex', '.claude', '.pi'].map((name) => join(homedir() || '/', name))
  if (defaults.some((folder) => inside(dir, folder)) || !inside(dir, accountsDir)) {
    throw new HarnessError('account_required', 'A session cannot start outside its isolated account folder.')
  }
}

/** Variables to set, or remove (`null`), when launching a session for this account. */
export function launchEnv(accountsDir: string, account: Pick<Account, 'id'>, inherited: NodeJS.ProcessEnv = process.env): Record<string, string | null> {
  const dir = ensureHome(accountsDir, account)
  assertIsolated(accountsDir, dir)
  const env: Record<string, string | null> = {}
  for (const name of inheritedCredentialVars(inherited)) env[name] = null
  env.PI_CODING_AGENT_DIR = dir
  return env
}

/** What a session needs to run for an account. */
export interface AccountContext {
  id: string
  provider: 'pi'
  label: string
  /** Variables to set; `null` removes an inherited one. */
  env: Record<string, string | null>
  /** The account's own agent folder. */
  configDir: string
}

export function accountContext(accountsDir: string, account: Account): AccountContext {
  return { id: account.id, provider: 'pi', label: account.label, env: launchEnv(accountsDir, account), configDir: configDir(accountsDir, account) }
}

/** The process environment for a `pi` process launched on behalf of this account. */
export function processEnv(account: AccountContext, inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(inherited)) if (value !== undefined) env[name] = value
  for (const [name, value] of Object.entries(account.env)) {
    if (value === null) delete env[name]
    else env[name] = value
  }
  return env
}

