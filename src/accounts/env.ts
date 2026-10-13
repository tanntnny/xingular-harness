// Isolated launch environments. Every Pi session the harness starts gets its account's own
// agent folder (`PI_CODING_AGENT_DIR`) under the state directory, and inherited credential
// variables are removed. A launch that would fall back to `~/.pi` is refused.
//
// Settings, skills, prompts, and instructions are shared by every account: the account's agent
// folder links those entries to `_shared/pi/`. Where the system refuses a link (Windows without
// the symlink privilege), the entry stays the account's own, and a shared file is copied in so
// its settings still load. Credentials, sessions, and history stay in the account's own folder.
import { chmodSync, copyFileSync, linkSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, utimesSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

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
  ['themes', true],
  // Where Pi keeps installed packages: one install serves every account.
  ['npm', true],
  ['git', true]
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

/** Moves a real file or folder aside so the shared link can take its place; returns where it went. */
function backUp(path: string): string {
  const backup = join(dirname(path), `${basename(path)}.agentx-backup-${Math.floor(Date.now() / 1000)}`)
  renameSync(path, backup)
  return backup
}

/**
 * How one shared entry is linked into an account folder. Windows refuses a symbolic link to a
 * user without the symlink privilege, so each kind has a fallback that needs none.
 */
export interface EntryLinker {
  /** A symbolic link to a file, or a junction to a folder (junctions need no privilege on Windows). */
  symlink(target: string, path: string, isDir: boolean): void
  /** A hard link to a file on the same volume. */
  hardLink(target: string, path: string): void
}

const nodeLinker: EntryLinker = {
  symlink: (target, path, isDir) => symlinkSync(resolve(target), path, isDir ? 'junction' : 'file'),
  hardLink: (target, path) => linkSync(target, path)
}

const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? String(error)
const PRIVILEGE_CODES = ['EPERM', 'EACCES']

function createLink(target: string, path: string, isDir: boolean, linker: EntryLinker): void {
  try {
    linker.symlink(target, path, isDir)
  } catch (error) {
    // A file can still be hard-linked without the privilege; a folder has no such fallback.
    if (isDir || !PRIVILEGE_CODES.includes(codeOf(error))) throw error
    linker.hardLink(target, path)
  }
}

const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

// Windows reports some link targets with the `\\?\` prefix.
const LONG_PREFIX = /^\\\\\?\\/
function samePath(a: string, b: string): boolean {
  const normal = (path: string): string => {
    const full = resolve(path.replace(LONG_PREFIX, ''))
    return process.platform === 'win32' ? full.toLowerCase() : full
  }
  return normal(a) === normal(b)
}

/** A hard link is the same file on disk as its target, so it has the same device and inode. */
function sameFile(a: string, b: string): boolean {
  try {
    const left = lstatSync(a)
    const right = lstatSync(b)
    return left.ino !== 0 && left.dev === right.dev && left.ino === right.ino
  } catch {
    return false
  }
}

function isLinkTo(path: string, target: string, isDir: boolean): boolean {
  try {
    const meta = lstatSync(path)
    if (meta.isSymbolicLink()) return samePath(readlinkSync(path), target)
    return !isDir && meta.isFile() && sameFile(path, target)
  } catch {
    return false
  }
}

/** Removes a link without touching what it points to. A Windows junction needs `rmdir`. */
function removeLink(path: string, isDir: boolean): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if (!isDir) throw error
    rmdirSync(path)
  }
}

/**
 * A file the account does not have, for an entry whose link was refused: a copy of the shared one
 * (with its time kept, so the newest-wins rule does not move it), so the account's settings load.
 */
function keepCopy(target: string, path: string, isDir: boolean): void {
  if (isDir || present(path) || !present(target)) return
  try {
    copyFileSync(target, path)
    const { atime, mtime } = statSync(target)
    utimesSync(path, atime, mtime)
  } catch {
    // The account simply keeps no copy; its sign-in and its own files are not affected.
  }
}

/** What happened to one shared entry: linked to the shared copy, or left as the account's own. */
export interface SharedEntry {
  name: string
  state: 'linked' | 'unshared'
  /** Why the link was refused, when it was. */
  reason?: string
}

/**
 * Links one entry to its shared copy. A real entry found in the account folder (from before
 * sharing, or a tool that replaced the link while saving) becomes the shared copy when there is
 * none or it is newer; otherwise it is kept as a backup. If the link is then refused, every move
 * is undone, so the account keeps what it had.
 */
function linkOne(name: string, target: string, path: string, isDir: boolean, linker: EntryLinker): SharedEntry {
  if (isLinkTo(path, target, isDir)) {
    if (isDir) mkdirSync(target, { recursive: true })
    return { name, state: 'linked' }
  }
  const undo: (() => void)[] = []
  try {
    if (isLink(path)) {
      const previous = readlinkSync(path)
      removeLink(path, isDir)
      undo.push(() => nodeLinker.symlink(previous, path, isDir))
    } else if (present(path)) {
      if (!present(target)) {
        renameSync(path, target)
        undo.push(() => renameSync(target, path))
      } else if (!isDir && modified(path) > modified(target)) {
        const backup = backUp(target)
        undo.push(() => renameSync(backup, target))
        renameSync(path, target)
        undo.push(() => renameSync(target, path))
      } else {
        const backup = backUp(path)
        undo.push(() => renameSync(backup, path))
      }
    }
    if (isDir) mkdirSync(target, { recursive: true })
    createLink(target, path, isDir, linker)
    return { name, state: 'linked' }
  } catch (error) {
    for (const step of undo.reverse()) {
      try {
        step()
      } catch {
        // The entry stays where that step left it; nothing further can be restored safely.
      }
    }
    keepCopy(target, path, isDir)
    return { name, state: 'unshared', reason: codeOf(error) }
  }
}

/**
 * Creates the account's runtime folder and links the shared entries into it. Never throws for a
 * refused link: each entry is reported, and the account falls back to its own copy.
 */
export function linkSharedEntries(accountsDir: string, account: Pick<Account, 'id'>, linker: EntryLinker = nodeLinker): { dir: string; entries: SharedEntry[] } {
  makePrivate(join(accountsDir, account.id))
  makePrivate(homeDir(accountsDir, account.id))
  const dir = configDir(accountsDir, account)
  makePrivate(dir)
  const shared = ensureSharedDir(accountsDir)
  const entries = SHARED_ENTRIES.map(([name, isDir]) => linkOne(name, join(shared, name), join(dir, name), isDir, linker))
  return { dir, entries }
}

/** Creates the account's runtime folder and links the shared entries into it. */
export function ensureHome(accountsDir: string, account: Pick<Account, 'id'>): string {
  return linkSharedEntries(accountsDir, account).dir
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

function sessionEnv(dir: string, inherited: NodeJS.ProcessEnv): Record<string, string | null> {
  const env: Record<string, string | null> = {}
  for (const name of inheritedCredentialVars(inherited)) env[name] = null
  env.PI_CODING_AGENT_DIR = dir
  return env
}

/** Variables to set, or remove (`null`), when launching a session for this account. */
export function launchEnv(accountsDir: string, account: Pick<Account, 'id'>, inherited: NodeJS.ProcessEnv = process.env): Record<string, string | null> {
  const dir = ensureHome(accountsDir, account)
  assertIsolated(accountsDir, dir)
  return sessionEnv(dir, inherited)
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
  /** Which shared entries are linked, and which the account keeps as its own. */
  sharing: SharedEntry[]
}

export function accountContext(accountsDir: string, account: Account): AccountContext {
  const { dir, entries } = linkSharedEntries(accountsDir, account)
  assertIsolated(accountsDir, dir)
  return { id: account.id, provider: 'pi', label: account.label, env: sessionEnv(dir, process.env), configDir: dir, sharing: entries }
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

