/** A managed worktree is disposable and pruned; a permanent one is kept until a person removes it. */
export type WorktreeKind = 'managed' | 'permanent'

export interface WorktreeLease {
  /** Who uses the worktree: a session id. */
  holder: string
  /** The process that holds the lease; a lease whose process is gone is released on recovery. */
  pid: number
  at: string
}

export interface WorktreeRecord {
  id: string
  /** The source checkout's top folder. */
  repoRoot: string
  path: string
  name: string
  /** Null while the worktree is on a detached HEAD. */
  branch: string | null
  baseRef: string
  baseCommit: string
  kind: WorktreeKind
  origin: 'created' | 'adopted'
  createdAt: string
  lastUsedAt: string
  lease: WorktreeLease | null
  /** Set once the checkout is removed; the record stays so the worktree can be restored. */
  removed: { at: string; head: string; snapshot: string | null } | null
}

export interface WorktreeStatus {
  record: WorktreeRecord
  exists: boolean
  head: string | null
  /** Changed, added or untracked paths in the working tree. */
  changes: number
  /** Commits made since the worktree started. */
  ahead: number
}

export interface CopyReport {
  copied: string[]
  skipped: { path: string; reason: 'exists' | 'symlink' | 'too_large' | 'over_total' | 'not_file' }[]
}

export interface SetupReport {
  state: 'none' | 'untrusted' | 'ran' | 'failed'
  /** The script's content hash, to trust it with `setup.trust`. */
  hash: string | null
  log: string | null
  exitCode?: number | null
}

export interface CreateWorktreeInput {
  /** Any folder inside the source repository. */
  repo: string
  name?: string
  /** What the worktree starts from. Defaults to the source checkout's HEAD. */
  baseRef?: string
  kind?: WorktreeKind
  /** A branch to create instead of a detached HEAD. The configured prefix is added. */
  branch?: string
  /** Bring the source checkout's uncommitted changes along (default when starting from HEAD). */
  carryChanges?: boolean
  /** Run the repository's trusted setup script (default yes). */
  setup?: boolean
}

export interface CreateWorktreeResult {
  worktree: WorktreeRecord
  carried: CopyReport & { patched: boolean }
  included: CopyReport
  setup: SetupReport
}

export interface HandoffResult {
  direction: 'toSource' | 'toWorktree'
  patched: boolean
  copied: string[]
  /** The stash that holds what was moved away from the origin, when `move` was asked. */
  stash: string | null
}

export interface WorktreesOptions {
  /** Where checkouts are made. Defaults to `<state dir>/worktrees`. */
  root?: string
  /** Prefix of branches the harness creates. Defaults to `wt/`. */
  branchPrefix?: string
  /** Managed worktrees kept per repository by `prune`. Defaults to 15. */
  keep?: number
}
