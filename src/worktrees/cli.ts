// `xagent worktree`: managed worktrees of the repository you are in, from a shell.
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { Worktrees } from './service'
import type { WorktreeRecord } from './types'

export const WORKTREE_USAGE = `Usage: xagent worktree <command> [--state <dir>]

  list                       Worktrees of the repository you are in
  new [name] [--branch <b>] [--permanent] [--from <ref>] [--no-carry]
                             Make a worktree (default: managed, detached, with your
                             uncommitted changes carried over)
  status <name|id>           Changes and commits since it started
  branch <name|id> <branch>  Give a detached worktree a branch
  handoff <name|id> to-main|to-worktree [--copy]
                             Move changes between it and your main checkout
                             (--copy leaves the origin as it was)
  rm <name|id> [--force]     Remove it; with --force, keep a snapshot of unsaved work
  restore <name|id>          Bring back a removed worktree, with its snapshot
  prune [--keep <n>]         Keep the most recent managed worktrees (default 15)
  adopt <path>               Manage an existing linked worktree
  trust-setup                Trust this repository's .xharness/worktree-setup as it is now
  path <name|id>             Print its folder (cd "$(xagent worktree path name)")

Start the terminal in a new managed worktree with: xagent --worktree [name]
`

interface Dependencies {
  home?: string
  cwd?: string
  write?: (text: string) => void
}

function describe(record: WorktreeRecord): string {
  const state = record.branch ?? 'detached'
  const lease = record.lease ? ' · in use' : ''
  return `${record.name.padEnd(20)} ${record.kind.padEnd(9)} ${state.padEnd(24)} ${record.path}${lease}`
}

export async function findWorktree(worktrees: Worktrees, cwd: string, key: string, removed = false): Promise<WorktreeRecord> {
  const repo = await worktrees.repositoryOf(cwd)
  const pool = removed ? worktrees.removed(repo) : await worktrees.list(repo)
  const match = pool.find((record) => record.id === key || record.name === key)
  if (!match) throw new Error(`No ${removed ? 'removed ' : ''}worktree named ${key} in this repository.`)
  return match
}

export async function runWorktreeCli(argv: string[], dependencies: Dependencies = {}): Promise<number> {
  const write = dependencies.write ?? ((text: string) => void process.stdout.write(text))
  const cwd = resolve(dependencies.cwd ?? process.cwd())
  const args: string[] = []
  let stateDir = join(dependencies.home ?? homedir(), '.xingular-harness', 'state')
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--state') stateDir = resolve(argv[++index] ?? stateDir)
    else args.push(argv[index])
  }
  const [command, ...rest] = args
  const flag = (name: string): boolean => rest.includes(name)
  const value = (name: string): string | undefined => {
    const index = rest.indexOf(name)
    return index >= 0 ? rest[index + 1] : undefined
  }
  const positional = rest.filter((item, index) => !item.startsWith('--') && !(index > 0 && ['--branch', '--from', '--keep'].includes(rest[index - 1])))
  const worktrees = new Worktrees(stateDir)

  switch (command) {
    case 'list': {
      const records = await worktrees.list(cwd)
      write(records.length ? `${records.map(describe).join('\n')}\n` : 'No worktrees for this repository.\n')
      return 0
    }
    case 'new': {
      const result = await worktrees.create({
        repo: cwd,
        ...(positional[0] ? { name: positional[0] } : {}),
        ...(value('--branch') ? { branch: value('--branch')! } : {}),
        ...(value('--from') ? { baseRef: value('--from')! } : {}),
        kind: flag('--permanent') ? 'permanent' : 'managed',
        ...(flag('--no-carry') ? { carryChanges: false } : {})
      })
      write(`${describe(result.worktree)}\n`)
      if (result.carried.copied.length || result.carried.patched) write(`Carried your uncommitted changes${result.carried.copied.length ? ` and ${result.carried.copied.length} untracked file(s)` : ''}.\n`)
      if (result.included.copied.length) write(`Copied ${result.included.copied.length} file(s) named in .worktreeinclude.\n`)
      if (result.setup.state === 'untrusted') write('The repository has a setup script you have not trusted. Read .xharness/worktree-setup, then run: xagent worktree trust-setup\n')
      if (result.setup.state === 'failed') write(`The setup script failed; see ${result.setup.log}.\n`)
      return 0
    }
    case 'status': {
      const status = await worktrees.status((await findWorktree(worktrees, cwd, positional[0] ?? '')).id)
      write(`${describe(status.record)}\n${status.changes} changed path(s), ${status.ahead} commit(s) since it started.\n`)
      return 0
    }
    case 'branch': {
      const record = await worktrees.branch((await findWorktree(worktrees, cwd, positional[0] ?? '')).id, positional[1] ?? '')
      write(`${describe(record)}\n`)
      return 0
    }
    case 'handoff': {
      const direction = positional[1] === 'to-main' ? 'toSource' : positional[1] === 'to-worktree' ? 'toWorktree' : null
      if (!direction) { write(WORKTREE_USAGE); return 2 }
      const result = await worktrees.handoff((await findWorktree(worktrees, cwd, positional[0] ?? '')).id, direction, { move: !flag('--copy') })
      write(result.patched || result.copied.length ? `Handed off${result.copied.length ? ` (and ${result.copied.length} untracked file(s))` : ''}.${result.stash ? ` The origin's copy is kept in git stash ${result.stash.slice(0, 12)}.` : ''}\n` : 'Nothing to hand off.\n')
      return 0
    }
    case 'rm': {
      const { worktree, snapshot } = await worktrees.remove((await findWorktree(worktrees, cwd, positional[0] ?? '')).id, { force: flag('--force') })
      write(`Removed ${worktree.name}.${snapshot ? ` Its unsaved work is kept; xagent worktree restore ${worktree.name} brings it back.` : ''}\n`)
      return 0
    }
    case 'restore': {
      const record = await worktrees.restore((await findWorktree(worktrees, cwd, positional[0] ?? '', true)).id)
      write(`${describe(record)}\n`)
      return 0
    }
    case 'prune': {
      const keep = value('--keep') ? Number(value('--keep')) : undefined
      const result = await worktrees.prune({ repo: cwd, ...(keep !== undefined && Number.isFinite(keep) ? { keep } : {}) })
      write(`Removed ${result.removed.length} worktree(s)${result.removed.some((entry) => entry.snapshot) ? ', keeping snapshots of unsaved work' : ''}.\n`)
      for (const failure of result.failed) write(`Could not remove ${failure.id}: ${failure.error}\n`)
      return result.failed.length ? 1 : 0
    }
    case 'adopt': {
      const record = await worktrees.adopt(resolve(cwd, positional[0] ?? ''))
      write(`${describe(record)}\n`)
      return 0
    }
    case 'trust-setup': {
      const { setupScript } = await import('./setup')
      const repo = await worktrees.repositoryOf(cwd)
      const script = setupScript(repo)
      if (!script) { write('This repository has no .xharness/worktree-setup.\n'); return 1 }
      await worktrees.trustSetup(repo, script.hash)
      write(`Trusted the setup script (sha256 ${script.hash.slice(0, 12)}…). A changed script asks again.\n`)
      return 0
    }
    case 'path': {
      write(`${(await findWorktree(worktrees, cwd, positional[0] ?? '')).path}\n`)
      return 0
    }
    default:
      write(WORKTREE_USAGE)
      return command && command !== 'help' ? 2 : 0
  }
}
