// Managed git worktrees (PROP-0016). A session can work in its own checkout of a repository so its
// edits never touch the person's main checkout: managed worktrees are disposable and pruned to the
// most recent few, permanent ones stay until a person removes them, and nothing with work in it is
// removed without a snapshot it can be restored from.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { HarnessError, invalid, notFound } from '../core/errors'
import { newId, now, readJsonOr, writeJson } from '../core/fs'
import { copyFiles, ignoredFiles, includedFiles, untrackedFiles } from './copy'
import { git, gitText, nulList } from './git'
import { runSetup, SetupTrust } from './setup'
import type { CreateWorktreeInput, CreateWorktreeResult, HandoffResult, WorktreeRecord, WorktreesOptions, WorktreeStatus } from './types'

interface Registry {
  version: 1
  worktrees: WorktreeRecord[]
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
const SNAPSHOT_REF = 'refs/xharness/snapshots'
const IDENTITY = { GIT_AUTHOR_NAME: 'Xingular Harness', GIT_AUTHOR_EMAIL: 'harness@localhost', GIT_COMMITTER_NAME: 'Xingular Harness', GIT_COMMITTER_EMAIL: 'harness@localhost' }

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'repo'
}

/** Paths in `git status --porcelain=v1 -z` output; a rename's original path is not counted. */
function statusPaths(output: string): string[] {
  const items = nulList(output)
  const paths: string[] = []
  for (let index = 0; index < items.length; index += 1) {
    const entry = items[index]
    paths.push(entry.slice(3))
    if (entry[0] === 'R' || entry[0] === 'C') index += 1
  }
  return paths
}

export class Worktrees {
  readonly root: string
  readonly branchPrefix: string
  readonly keep: number
  private readonly registryFile: string
  private readonly trust: SetupTrust
  private readonly leaseCounts = new Map<string, number>()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(stateDir: string, options: WorktreesOptions = {}) {
    this.root = options.root ?? join(stateDir, 'worktrees')
    this.branchPrefix = options.branchPrefix ?? 'wt/'
    this.keep = options.keep ?? 15
    this.registryFile = join(stateDir, 'worktrees.json')
    this.trust = new SetupTrust(join(stateDir, 'worktree-setup-trust.json'))
    this.recover(true)
  }

  // ---- Registry -------------------------------------------------------------------------------

  private read(): Registry {
    const registry = readJsonOr<Registry>(this.registryFile, { version: 1, worktrees: [] })
    return Array.isArray(registry.worktrees) ? registry : { version: 1, worktrees: [] }
  }

  private write(registry: Registry): void {
    writeJson(this.registryFile, registry)
  }

  private update(id: string, change: (record: WorktreeRecord) => void): WorktreeRecord {
    const registry = this.read()
    const record = registry.worktrees.find((entry) => entry.id === id)
    if (!record) throw notFound(`Worktree ${id}`)
    change(record)
    this.write(registry)
    return record
  }

  /** Runs changes one at a time, so two requests never race on the registry or on git. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work)
    this.chain = next.catch(() => undefined)
    return next
  }

  /** Releases leases whose process is gone. At start-up, this process's own leases are stale too. */
  recover(startup = false): string[] {
    const registry = this.read()
    const released: string[] = []
    for (const record of registry.worktrees) {
      if (!record.lease) continue
      if (alive(record.lease.pid) && !(startup && record.lease.pid === process.pid)) continue
      record.lease = null
      this.leaseCounts.delete(record.id)
      released.push(record.id)
      if (existsSync(record.path)) void git(record.path, ['worktree', 'unlock', record.path], { allowFail: true }).catch(() => undefined)
    }
    if (released.length) this.write(registry)
    return released
  }

  get(id: string): WorktreeRecord {
    const record = this.read().worktrees.find((entry) => entry.id === id)
    if (!record) throw notFound(`Worktree ${id}`)
    return record
  }

  private active(id: string): WorktreeRecord {
    const record = this.get(id)
    if (record.removed) throw new HarnessError('worktree_removed', `Worktree ${record.name} was removed.`, 'Restore it first.')
    return record
  }

  /** The folder for a registered worktree; unknown ids remain opaque to the caller. */
  pathOf(id: string): string | null {
    const record = this.read().worktrees.find((entry) => entry.id === id)
    if (!record) return null
    if (record.removed) throw new HarnessError('worktree_removed', `Worktree ${record.name} was removed.`, 'Restore it first.')
    if (!existsSync(record.path)) throw new HarnessError('worktree_missing', `The folder of worktree ${record.name} is gone.`, 'Remove it, or restore it.')
    return record.path
  }

  /** The top folder of the repository a folder belongs to (the main checkout, for a linked worktree). */
  async repositoryOf(folder: string): Promise<string> {
    const known = this.read().worktrees.find((entry) => !entry.removed && real(entry.path) === real(folder))
    if (known) return known.repoRoot
    const top = await git(folder, ['rev-parse', '--show-toplevel'], { allowFail: true })
    if (top.code !== 0) throw new HarnessError('not_a_repository', `${folder} is not inside a git repository.`, 'Worktrees need a git repository with at least one commit.')
    const gitDir = await gitText(folder, ['rev-parse', '--absolute-git-dir'])
    const common = resolve(top.stdout.trim(), await gitText(folder, ['rev-parse', '--git-common-dir']))
    if (real(gitDir) === real(common)) return real(top.stdout.trim())
    const main = (await gitText(folder, ['worktree', 'list', '--porcelain'])).split('\n').find((line) => line.startsWith('worktree '))
    return real(main ? main.slice('worktree '.length) : top.stdout.trim())
  }

  async list(repo?: string | null): Promise<WorktreeRecord[]> {
    const root = repo ? await this.repositoryOf(repo) : null
    return this.read().worktrees.filter((record) => !record.removed && (!root || record.repoRoot === root))
  }

  /** Worktrees removed with a snapshot, which `restore` can bring back. */
  removed(repo?: string | null): WorktreeRecord[] {
    return this.read().worktrees.filter((record) => record.removed && (!repo || record.repoRoot === real(repo)))
  }

  async status(id: string): Promise<WorktreeStatus> {
    const record = this.get(id)
    if (record.removed || !existsSync(record.path)) return { record, exists: false, head: null, changes: 0, ahead: 0 }
    const head = (await git(record.path, ['rev-parse', 'HEAD'], { allowFail: true })).stdout.trim() || null
    const changes = statusPaths((await git(record.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout).length
    const ahead = head ? Number((await git(record.path, ['rev-list', '--count', `${record.baseCommit}..HEAD`], { allowFail: true })).stdout.trim() || 0) : 0
    return { record, exists: true, head, changes, ahead }
  }

  // ---- Create and adopt -----------------------------------------------------------------------

  private repoKey(repoRoot: string): string {
    return `${slug(basename(repoRoot))}-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 8)}`
  }

  private uniqueName(repoRoot: string, wanted?: string): string {
    const taken = new Set(this.read().worktrees.filter((record) => record.repoRoot === repoRoot && !record.removed).map((record) => record.name))
    const folder = join(this.root, this.repoKey(repoRoot))
    if (wanted !== undefined) {
      if (!NAME.test(wanted)) throw invalid('A worktree name uses lowercase letters, digits and dashes (at most 63).')
      if (taken.has(wanted) || existsSync(join(folder, wanted))) throw new HarnessError('worktree_exists', `A worktree named ${wanted} already exists.`)
      return wanted
    }
    for (;;) {
      const name = `wt-${randomBytes(3).toString('hex')}`
      if (!taken.has(name) && !existsSync(join(folder, name))) return name
    }
  }

  private async branchName(repoRoot: string, name: string): Promise<string> {
    const full = `${this.branchPrefix}${name}`
    const check = await git(repoRoot, ['check-ref-format', '--branch', full], { allowFail: true })
    if (check.code !== 0) throw invalid(`${full} is not a valid branch name.`)
    if ((await git(repoRoot, ['rev-parse', '--verify', '-q', `refs/heads/${full}`], { allowFail: true })).code === 0) throw new HarnessError('branch_exists', `Branch ${full} already exists.`)
    return full
  }

  create(input: CreateWorktreeInput): Promise<CreateWorktreeResult> {
    return this.serial(async () => {
      if (!input?.repo) throw invalid('A repository folder is required.')
      const repoRoot = await this.repositoryOf(input.repo)
      if ((await git(repoRoot, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { allowFail: true })).code !== 0) {
        throw new HarnessError('repository_empty', 'This repository has no commit yet, so a worktree cannot be made from it.')
      }
      const name = this.uniqueName(repoRoot, input.name)
      const baseRef = input.baseRef || 'HEAD'
      const baseCommit = (await git(repoRoot, ['rev-parse', '--verify', '-q', `${baseRef}^{commit}`], { allowFail: true })).stdout.trim()
      if (!baseCommit) throw invalid(`${baseRef} does not name a commit.`)
      const branch = input.branch ? await this.branchName(repoRoot, input.branch) : null
      const path = join(this.root, this.repoKey(repoRoot), name)
      mkdirSync(dirname(path), { recursive: true })
      await git(repoRoot, ['worktree', 'add', ...(branch ? ['-b', branch] : ['--detach']), path, baseCommit])
      const at = now()
      const record: WorktreeRecord = {
        id: newId(), repoRoot, path, name, branch, baseRef, baseCommit, kind: input.kind ?? 'managed', origin: 'created',
        createdAt: at, lastUsedAt: at, lease: null, removed: null
      }
      const registry = this.read()
      registry.worktrees.push(record)
      this.write(registry)

      let patched = false
      let carried = { copied: [] as string[], skipped: [] as CreateWorktreeResult['carried']['skipped'] }
      if (input.carryChanges ?? baseRef === 'HEAD') {
        const patch = (await git(repoRoot, ['diff', '--binary', 'HEAD'])).stdout
        if (patch.trim()) patched = (await git(path, ['apply', '--binary', '--whitespace=nowarn'], { input: patch, allowFail: true })).code === 0
        carried = copyFiles(repoRoot, path, await untrackedFiles(repoRoot))
      }
      const included = copyFiles(repoRoot, path, await includedFiles(repoRoot))
      const setup = input.setup === false
        ? { state: 'none' as const, hash: null, log: null }
        : await runSetup({ checkout: path, source: repoRoot, name, repoRoot, logFile: join(this.root, 'logs', `${record.id}.setup.log`), trust: this.trust })
      return { worktree: record, carried: { ...carried, patched }, included, setup }
    })
  }

  adopt(path: string): Promise<WorktreeRecord> {
    return this.serial(async () => {
      if (!path || !isAbsolute(path)) throw invalid('An absolute worktree folder is required.')
      const folder = real(path)
      const known = this.read().worktrees.find((record) => !record.removed && real(record.path) === folder)
      if (known) return known
      const top = await git(folder, ['rev-parse', '--show-toplevel'], { allowFail: true })
      if (top.code !== 0 || real(top.stdout.trim()) !== folder) throw new HarnessError('not_a_worktree', `${path} is not the top folder of a git worktree.`)
      const repoRoot = await this.repositoryOf(folder)
      if (repoRoot === folder) throw new HarnessError('not_a_worktree', `${path} is a repository's main checkout, not a linked worktree.`)
      const branch = (await git(folder, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true })).stdout.trim() || null
      const head = await gitText(folder, ['rev-parse', 'HEAD'])
      const taken = new Set(this.read().worktrees.filter((record) => record.repoRoot === repoRoot && !record.removed).map((record) => record.name))
      let name = slug(basename(folder)).slice(0, 56) || 'adopted'
      if (!/^[a-z0-9]/.test(name)) name = `w-${name}`
      for (let suffix = 2; taken.has(name); suffix += 1) name = `${name.replace(/-\d+$/, '')}-${suffix}`
      const at = now()
      const record: WorktreeRecord = {
        id: newId(), repoRoot, path: folder, name, branch, baseRef: 'HEAD', baseCommit: head, kind: 'permanent', origin: 'adopted',
        createdAt: at, lastUsedAt: at, lease: null, removed: null
      }
      const registry = this.read()
      registry.worktrees.push(record)
      this.write(registry)
      return record
    })
  }

  // ---- Use ------------------------------------------------------------------------------------

  /** A session starts using a worktree. Another live session's lease refuses it. */
  acquire(id: string, holder: string): Promise<WorktreeRecord> {
    return this.serial(async () => {
      const record = this.active(id)
      if (!existsSync(record.path)) throw new HarnessError('worktree_missing', `The folder of worktree ${record.name} is gone.`, 'Remove it, or restore it.')
      if (record.lease && record.lease.holder !== holder && alive(record.lease.pid)) {
        throw new HarnessError('worktree_in_use', `Worktree ${record.name} is in use by another session.`)
      }
      const sameLiveLease = record.lease?.holder === holder && alive(record.lease.pid)
      const previousCount = sameLiveLease ? this.leaseCounts.get(id) ?? 1 : 0
      const updated = this.update(id, (entry) => {
        entry.lease = { holder, pid: process.pid, at: now() }
        entry.lastUsedAt = now()
      })
      this.leaseCounts.set(id, previousCount + 1)
      try {
        await git(record.path, ['worktree', 'lock', '--reason', 'in use by a Xingular Harness session', record.path], { allowFail: true })
      } catch (error) {
        if (previousCount) this.leaseCounts.set(id, previousCount)
        else {
          this.leaseCounts.delete(id)
          this.update(id, (entry) => { entry.lease = null })
        }
        throw error
      }
      return updated
    })
  }

  release(id: string, holder: string): Promise<void> {
    return this.serial(async () => {
      const record = this.read().worktrees.find((entry) => entry.id === id)
      if (!record?.lease || record.lease.holder !== holder) return
      const count = this.leaseCounts.get(id) ?? 1
      if (count > 1) {
        this.leaseCounts.set(id, count - 1)
        return
      }
      this.leaseCounts.delete(id)
      this.update(id, (entry) => { entry.lease = null })
      if (existsSync(record.path)) await git(record.path, ['worktree', 'unlock', record.path], { allowFail: true })
    })
  }

  branch(id: string, name: string): Promise<WorktreeRecord> {
    return this.serial(async () => {
      const record = this.active(id)
      if (record.branch) throw new HarnessError('branch_exists', `Worktree ${record.name} is already on branch ${record.branch}.`)
      const full = await this.branchName(record.repoRoot, name)
      await git(record.path, ['switch', '-c', full])
      return this.update(id, (entry) => { entry.branch = full })
    })
  }

  // ---- Remove, restore, prune -----------------------------------------------------------------

  private async reachable(checkout: string, commit: string): Promise<boolean> {
    const refs = await git(checkout, ['for-each-ref', '--count=1', `--contains=${commit}`, 'refs/heads', 'refs/tags', 'refs/remotes'], { allowFail: true })
    return refs.code === 0 && refs.stdout.trim().length > 0
  }

  /** Records the worktree's commits and working changes under a snapshot ref. */
  private async snapshot(record: WorktreeRecord, ignored: readonly string[]): Promise<string> {
    const index = join(tmpdir(), `xharness-index-${record.id}-${randomBytes(4).toString('hex')}`)
    const env = { ...IDENTITY, GIT_INDEX_FILE: index }
    try {
      await git(record.path, ['read-tree', 'HEAD'], { env })
      await git(record.path, ['add', '-A'], { env })
      if (ignored.length) {
        const pathspecs = Buffer.from(ignored.map((path) => `:(literal)${path}\0`).join(''))
        await git(record.path, ['add', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: pathspecs })
      }
      const tree = await gitText(record.path, ['write-tree'], { env })
      const commit = await gitText(record.path, ['commit-tree', tree, '-p', 'HEAD', '-m', `Xingular Harness snapshot of worktree ${record.name}`], { env })
      const ref = `${SNAPSHOT_REF}/${record.id}`
      await git(record.path, ['update-ref', ref, commit])
      return ref
    } finally {
      rmSync(index, { force: true })
    }
  }

  remove(id: string, options: { force?: boolean } = {}): Promise<{ worktree: WorktreeRecord; snapshot: string | null }> {
    return this.serial(() => this.removeNow(id, options.force === true))
  }

  private async removeNow(id: string, force: boolean): Promise<{ worktree: WorktreeRecord; snapshot: string | null }> {
    const record = this.active(id)
    // Several sessions share one process in an embedding host, so a lease of a live process always counts.
    if (record.lease && alive(record.lease.pid)) {
      throw new HarnessError('worktree_in_use', `Worktree ${record.name} is in use by a session.`, 'End that session first.')
    }
    let head = record.baseCommit
    let snapshot: string | null = null
    if (existsSync(record.path)) {
      const ignored = await ignoredFiles(record.path)
      const status = await this.status(id)
      head = status.head ?? head
      const work = status.changes > 0 || ignored.length > 0 || !(await this.reachable(record.path, head))
      if (work && !force) {
        throw new HarnessError('worktree_has_work', `Worktree ${record.name} has ${status.changes} changed path(s), ${ignored.length} ignored file(s), or commits on no branch.`, 'Remove it with force to keep a snapshot you can restore.')
      }
      if (work) snapshot = await this.snapshot(record, ignored)
      await git(record.repoRoot, ['worktree', 'unlock', record.path], { allowFail: true })
      const removed = await git(record.repoRoot, ['worktree', 'remove', '--force', record.path], { allowFail: true })
      if (removed.code !== 0 && existsSync(record.path) && record.path.startsWith(this.root + '/')) rmSync(record.path, { recursive: true, force: true })
    }
    await git(record.repoRoot, ['worktree', 'prune'], { allowFail: true })
    const worktree = this.update(id, (entry) => {
      entry.lease = null
      entry.removed = { at: now(), head, snapshot }
    })
    this.leaseCounts.delete(id)
    return { worktree, snapshot }
  }

  restore(id: string): Promise<WorktreeRecord> {
    return this.serial(async () => {
      const record = this.get(id)
      if (!record.removed) throw new HarnessError('worktree_active', `Worktree ${record.name} was not removed.`)
      if (existsSync(record.path)) throw new HarnessError('worktree_exists', `${record.path} already exists.`)
      const { snapshot, head } = record.removed
      const start = snapshot ? await gitText(record.repoRoot, ['rev-parse', `${snapshot}^`]) : head
      const onBranch = record.branch && (await git(record.repoRoot, ['rev-parse', '--verify', '-q', `refs/heads/${record.branch}`], { allowFail: true })).stdout.trim() === start
      mkdirSync(dirname(record.path), { recursive: true })
      await git(record.repoRoot, ['worktree', 'add', ...(onBranch ? [record.path, record.branch!] : ['--detach', record.path, start])])
      if (snapshot) {
        await git(record.path, ['read-tree', '-u', '--reset', snapshot])
        await git(record.path, ['reset', '-q'])
      }
      return this.update(id, (entry) => {
        entry.removed = null
        entry.branch = onBranch ? entry.branch : null
        entry.lastUsedAt = now()
      })
    })
  }

  /** Keeps the most recently used managed worktrees of each repository and removes the rest, with snapshots. */
  prune(options: { repo?: string | null; keep?: number } = {}): Promise<{ removed: { worktree: WorktreeRecord; snapshot: string | null }[]; failed: { id: string; error: string }[] }> {
    return this.serial(async () => {
      const keep = Math.max(0, options.keep ?? this.keep)
      const root = options.repo ? await this.repositoryOf(options.repo) : null
      const groups = new Map<string, WorktreeRecord[]>()
      for (const record of this.read().worktrees) {
        if (record.removed || record.kind !== 'managed' || (root && record.repoRoot !== root)) continue
        groups.set(record.repoRoot, [...(groups.get(record.repoRoot) ?? []), record])
      }
      const removed: { worktree: WorktreeRecord; snapshot: string | null }[] = []
      const failed: { id: string; error: string }[] = []
      for (const records of groups.values()) {
        const older = records.sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt)).slice(keep)
        for (const record of older) {
          if (record.lease && alive(record.lease.pid)) continue
          try {
            removed.push(await this.removeNow(record.id, true))
          } catch (error) {
            failed.push({ id: record.id, error: error instanceof Error ? error.message : String(error) })
          }
        }
      }
      return { removed, failed }
    })
  }

  // ---- Handoff --------------------------------------------------------------------------------

  /**
   * Moves work between the worktree and the main checkout. `toSource` brings the worktree's changes
   * since it started (commits and working changes) to the main checkout; `toWorktree` brings the
   * main checkout's uncommitted changes to the worktree. The target must have no tracked changes,
   * and nothing changes when the patch does not apply. With `move` (the default), what was handed
   * off is stashed away from the origin, where `git stash` can bring it back.
   */
  handoff(id: string, direction: 'toSource' | 'toWorktree', options: { move?: boolean } = {}): Promise<HandoffResult> {
    return this.serial(async () => {
      if (direction !== 'toSource' && direction !== 'toWorktree') throw invalid('direction is toSource or toWorktree.')
      const record = this.active(id)
      if (!existsSync(record.path)) throw new HarnessError('worktree_missing', `The folder of worktree ${record.name} is gone.`)
      const origin = direction === 'toSource' ? record.path : record.repoRoot
      const target = direction === 'toSource' ? record.repoRoot : record.path
      const dirty = (await gitText(target, ['status', '--porcelain', '--untracked-files=no'])).length > 0
      if (dirty) throw new HarnessError('handoff_target_dirty', `The ${direction === 'toSource' ? 'main checkout' : 'worktree'} has uncommitted changes.`, 'Commit or stash them, then hand off again.')
      const patch = (await git(origin, ['diff', '--binary', direction === 'toSource' ? record.baseCommit : 'HEAD'])).stdout
      const untracked = await untrackedFiles(origin)
      const collisions = untracked.filter((path) => existsSync(join(target, path)))
      if (collisions.length) throw new HarnessError('handoff_conflict', `${collisions.length} untracked file(s) already exist in the target, for example ${collisions[0]}.`)
      if (patch.trim()) {
        const check = await git(target, ['apply', '--check', '--binary', '--whitespace=nowarn'], { input: patch, allowFail: true })
        if (check.code !== 0) throw new HarnessError('handoff_conflict', `The changes do not apply cleanly: ${check.stderr.trim()}`, 'Bring the two checkouts to the same commit, or commit and merge instead.')
        await git(target, ['apply', '--binary', '--whitespace=nowarn'], { input: patch })
      }
      const copied = copyFiles(origin, target, untracked).copied
      let stash: string | null = null
      if (options.move !== false && (patch.trim() || untracked.length)) {
        const before = (await git(origin, ['rev-parse', '-q', '--verify', 'refs/stash'], { allowFail: true })).stdout.trim()
        await git(origin, ['stash', 'push', '--include-untracked', '-m', `Xingular Harness handoff of worktree ${record.name}`], { env: IDENTITY, allowFail: true })
        const after = (await git(origin, ['rev-parse', '-q', '--verify', 'refs/stash'], { allowFail: true })).stdout.trim()
        stash = after && after !== before ? after : null
      }
      this.update(id, (entry) => { entry.lastUsedAt = now() })
      return { direction, patched: patch.trim().length > 0, copied, stash }
    })
  }

  // ---- Setup trust ----------------------------------------------------------------------------

  async trustSetup(repo: string, hash: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw invalid('A setup script hash is 64 hexadecimal characters.')
    this.trust.trust(await this.repositoryOf(repo), hash)
  }
}
