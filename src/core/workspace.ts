import { lstatSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { invalid } from './errors'

/** The nearest Git repository containing `cwd`, or its canonical directory when there is none. */
export function resolveWorkspaceRoot(cwd: string): string {
  const canonicalCwd = realpathSync(cwd)
  if (!statSync(canonicalCwd).isDirectory()) throw invalid('The working directory must be a directory.')
  if (dirname(canonicalCwd) === canonicalCwd) throw invalid('The filesystem root cannot be used as an active project workspace.')

  let directory = canonicalCwd
  while (true) {
    try {
      const marker = lstatSync(resolve(directory, '.git'))
      if (marker.isDirectory() || marker.isFile()) return directory
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const parent = dirname(directory)
    if (parent === directory) return canonicalCwd
    directory = parent
  }
}

/**
 * Resolves a write target relative to `cwd` (the workspace root by default), and returns its
 * canonical path only when the target stays inside the canonical workspace root.
 */
export function resolveWorkspaceWritePath(workspaceRoot: string, candidate: string, cwd = workspaceRoot): string {
  const canonicalCandidate = resolveWritePath(candidate, cwd)
  if (!isWithinWorkspace(workspaceRoot, canonicalCandidate)) throw invalid('Write target is outside the active project workspace.')
  return canonicalCandidate
}

/** Canonicalizes an absolute, relative, or home-relative write target without imposing a root. */
export function resolveWritePath(candidate: string, cwd = process.cwd()): string {
  const expanded = candidate === '~'
    ? homedir()
    : candidate.startsWith('~/') || candidate.startsWith('~\\')
      ? join(homedir(), candidate.slice(2))
      : candidate
  const absoluteCandidate = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
  return canonicalizeTarget(absoluteCandidate)
}

/** Whether a canonical target is within the workspace's canonical filesystem root. */
export function isWithinWorkspace(workspaceRoot: string, canonicalCandidate: string): boolean {
  const canonicalRoot = realpathSync(workspaceRoot)
  if (!statSync(canonicalRoot).isDirectory()) throw invalid('The workspace root must be a directory.')
  const fromRoot = relative(canonicalRoot, canonicalCandidate)
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
}

/** Revalidates a root pinned by an active run; a replaced or redirected root fails closed. */
export function verifyWorkspaceRoot(workspaceRoot: string): string {
  const canonicalRoot = realpathSync(workspaceRoot)
  if (dirname(canonicalRoot) === canonicalRoot) throw invalid('The filesystem root cannot be used as an active project workspace.')
  if (canonicalRoot !== resolve(workspaceRoot) || !statSync(canonicalRoot).isDirectory()) {
    throw invalid('The active project workspace changed after this run began.')
  }
  return canonicalRoot
}

function canonicalizeTarget(path: string): string {
  const missing: string[] = []
  let current = path

  while (true) {
    let exists = false
    try {
      lstatSync(current)
      exists = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    if (exists) return resolve(realpathSync(current), ...missing.reverse())

    const parent = dirname(current)
    if (parent === current) throw invalid('Write target could not be resolved.')
    missing.push(basename(current))
    current = parent
  }
}
