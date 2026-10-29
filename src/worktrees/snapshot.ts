// A snapshot of a working tree at the start of a turn: a commit object holding the tracked edits
// and the untracked, non-ignored files, made through a throwaway index. The working tree, the real
// index, HEAD and every ref stay as they were; the only trace is unreferenced objects in the
// repository's object store, which git's own garbage collection removes in time. Refinement
// replays a request from it (page 05).
import { copyFileSync, existsSync, lstatSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { git, gitText, nulList } from './git'

export interface WorkspaceSnapshot {
  kind: 'git-snapshot'
  /** The repository's top-level folder. */
  repo: string
  /** The snapshot commit; its parent is HEAD when there is one. */
  commit: string
  /** Untracked files left out because they were too large or too many. */
  omitted?: number
}

// The same bounds managed worktrees use when they carry untracked files.
const FILE_CAP = 5 * 1024 * 1024
const TOTAL_CAP = 100 * 1024 * 1024
const COUNT_CAP = 10_000

export interface SnapshotOptions {
  /** Give up after this long and return null; a slow snapshot must not hold up a turn. */
  timeoutMs?: number
}

export const SNAPSHOT_TIMEOUT_MS = 2_000

// Fixed identity so a repository without user.name and user.email still gets a snapshot.
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Turn snapshot',
  GIT_AUTHOR_EMAIL: 'snapshot@localhost.invalid',
  GIT_COMMITTER_NAME: 'Turn snapshot',
  GIT_COMMITTER_EMAIL: 'snapshot@localhost.invalid'
}

/** Snapshots the working tree that holds `cwd`, or returns null outside git, on failure or on timeout. */
export async function snapshotWorkingTree(cwd: string, options: SnapshotOptions = {}): Promise<WorkspaceSnapshot | null> {
  const deadline = Date.now() + (options.timeoutMs ?? SNAPSHOT_TIMEOUT_MS)
  const left = () => Math.max(1, deadline - Date.now())
  let scratch: string | null = null
  try {
    const top = await git(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true, timeoutMs: left() })
    if (top.code !== 0) return null
    const repo = top.stdout.trim()
    const head = await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true, timeoutMs: left() })
    const parent = head.code === 0 ? head.stdout.trim() : null
    const indexPath = await gitText(repo, ['rev-parse', '--git-path', 'index'], { timeoutMs: left() })
    const realIndex = isAbsolute(indexPath) ? indexPath : resolve(repo, indexPath)
    scratch = mkdtempSync(join(tmpdir(), 'harness-snapshot-'))
    const index = join(scratch, 'index')
    // Starting from a copy of the real index keeps `add` incremental on a large tree. The copy keeps
    // the index's own time, rounded down: git compares it with each file's time to catch an edit in
    // the same second that kept the size ("racy git"), and a fresh time would hide such an edit.
    if (existsSync(realIndex)) {
      copyFileSync(realIndex, index)
      const { atimeMs, mtimeMs } = statSync(realIndex)
      utimesSync(index, Math.floor(atimeMs) / 1000, Math.floor(mtimeMs) / 1000 - 0.001)
    }
    const env = { ...IDENTITY, GIT_INDEX_FILE: index }
    // Tracked edits and deletions, then untracked files within bounds: a large file nobody
    // ignored is never hashed into the repository on every turn.
    await git(repo, ['add', '--update', '--', '.'], { env, timeoutMs: left() })
    const untracked = nulList((await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'], { env, timeoutMs: left() })).stdout)
    const chosen: string[] = []
    let total = 0
    for (const path of untracked) {
      let size: number
      try {
        const stat = lstatSync(join(repo, path))
        if (!stat.isFile() && !stat.isSymbolicLink()) continue
        size = stat.size
      } catch {
        continue
      }
      if (chosen.length >= COUNT_CAP || size > FILE_CAP || total + size > TOTAL_CAP) continue
      chosen.push(path)
      total += size
    }
    if (chosen.length) await git(repo, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: `${chosen.join('\0')}\0`, timeoutMs: left() })
    const omitted = untracked.length - chosen.length
    const tree = await gitText(repo, ['write-tree'], { env, timeoutMs: left() })
    const commit = await gitText(repo, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Turn snapshot'], { env, timeoutMs: left() })
    return /^[0-9a-f]{40,64}$/.test(commit) ? { kind: 'git-snapshot', repo, commit, ...(omitted > 0 ? { omitted } : {}) } : null
  } catch {
    return null
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  }
}
