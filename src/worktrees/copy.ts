// Copies files git does not track into a worktree: untracked work carried from the source, and the
// ignored files `.worktreeinclude` names (local settings, `.env`). A file is never overwritten, a
// symlink is never followed, and sizes are capped.
import { copyFileSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { HarnessError } from '../core/errors'
import { safeRelative } from '../core/fs'
import { git, nulList } from './git'
import type { CopyReport } from './types'

export const INCLUDE_FILE = '.worktreeinclude'
const FILE_CAP = 5 * 1024 * 1024
const TOTAL_CAP = 100 * 1024 * 1024
const IGNORED_FILE_COUNT_CAP = 10_000
const IGNORED_PATH_BYTES_CAP = 1024 * 1024

export function copyFiles(from: string, to: string, paths: readonly string[]): CopyReport {
  const report: CopyReport = { copied: [], skipped: [] }
  let total = 0
  for (const path of paths) {
    let relative: string
    try {
      relative = safeRelative(path)
    } catch {
      continue
    }
    const source = join(from, relative)
    const target = join(to, relative)
    if (existsSync(target)) { report.skipped.push({ path: relative, reason: 'exists' }); continue }
    let stat
    try {
      stat = lstatSync(source)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) { report.skipped.push({ path: relative, reason: 'symlink' }); continue }
    if (!stat.isFile()) { report.skipped.push({ path: relative, reason: 'not_file' }); continue }
    if (stat.size > FILE_CAP) { report.skipped.push({ path: relative, reason: 'too_large' }); continue }
    if (total + stat.size > TOTAL_CAP) { report.skipped.push({ path: relative, reason: 'over_total' }); continue }
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    total += stat.size
    report.copied.push(relative)
  }
  return report
}

/** Untracked files that are not ignored: new work a person has not added yet. */
export async function untrackedFiles(checkout: string): Promise<string[]> {
  return nulList((await git(checkout, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout)
}

/** All ignored user files that must be bounded and captured before a worktree is removed. */
export async function ignoredFiles(checkout: string): Promise<string[]> {
  const paths = nulList((await git(checkout, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).stdout)
  if (paths.length > IGNORED_FILE_COUNT_CAP) throw ignoredFilesError(`there are more than ${IGNORED_FILE_COUNT_CAP} ignored files`)
  let total = 0
  let pathBytes = 0
  return paths.map((path) => {
    let relative: string
    try {
      relative = safeRelative(path)
    } catch {
      throw ignoredFilesError('an ignored path is unsafe')
    }
    pathBytes += Buffer.byteLength(relative) + 10
    if (pathBytes > IGNORED_PATH_BYTES_CAP) throw ignoredFilesError('the ignored paths exceed the snapshot limit')
    let stat
    try {
      stat = lstatSync(join(checkout, relative))
    } catch {
      throw ignoredFilesError(`could not inspect ${relative}`)
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) throw ignoredFilesError(`${relative} is not a regular file or symlink`)
    if (stat.size > FILE_CAP) throw ignoredFilesError(`${relative} exceeds the ${FILE_CAP}-byte per-file limit`)
    total += stat.size
    if (total > TOTAL_CAP) throw ignoredFilesError(`ignored files exceed the ${TOTAL_CAP}-byte total limit`)
    return relative
  })
}

function ignoredFilesError(reason: string): HarnessError {
  return new HarnessError('worktree_has_work', `Ignored files cannot be safely preserved: ${reason}.`, 'Move or remove those files, then try again.')
}

/** Ignored files that match `.worktreeinclude`, matched by git itself. */
export async function includedFiles(checkout: string): Promise<string[]> {
  const patterns = join(checkout, INCLUDE_FILE)
  if (!existsSync(patterns)) return []
  const ignored = new Set(nulList((await git(checkout, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).stdout))
  const matching = nulList((await git(checkout, ['ls-files', '--others', '--ignored', `--exclude-from=${patterns}`, '-z'])).stdout)
  return matching.filter((path) => ignored.has(path))
}
