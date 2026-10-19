// The application's part in refinement (the seventh extension point). The harness runs the
// method; the application says where an execution may work, as whom, with which tools, and what
// it produced. Nothing here names an application concept.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

import type { CallerContext } from '../core/caller'
import type { Launch } from '../prompt/compile'
import type { Effort } from '../sessions/runner'
import type { RefineTask } from './types'

/** How one execution of a task runs: who it works as and with what. */
export interface RolloutSession {
  caller: CallerContext
  tools: { allow: string[]; gated?: string[] }
  launch?: Launch
  model?: string | null
  effort?: Effort | null
  accountId?: string | null
  poolId?: string | null
  connections?: boolean | { readOnly?: boolean }
  providers?: boolean
}

export interface RolloutWorkspace {
  /** The folder the execution works in. It must not be a folder a person is working in. */
  cwd: string
  /** Called after what the execution produced has been read. */
  cleanup?: () => Promise<void>
}

export interface RefineHost {
  /** A fresh, isolated folder for one execution. */
  prepareWorkspace(input: { refineId: string; label: string; task: RefineTask }): Promise<RolloutWorkspace>
  /** The session settings an execution runs with. */
  session(input: { refineId: string; label: string; task: RefineTask }): Promise<RolloutSession>
  /** What one execution produced, filename → readable text. Defaults to its reply and the files it changed. */
  deliverable?(input: { cwd: string; reply: string; task: RefineTask }): Promise<Record<string, string>>
}

const TEXT_LIMIT = 200_000
const FILES_LIMIT = 40

function files(dir: string, into: string[] = [], base = dir): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return into
  }
  for (const name of names.sort()) {
    if (name === '.git' || name === 'node_modules' || name.startsWith('.')) continue
    const path = join(dir, name)
    try {
      if (statSync(path).isDirectory()) files(path, into, base)
      else into.push(relative(base, path).split(sep).join('/'))
    } catch {
      // Skip what cannot be read.
    }
    if (into.length > 2_000) break
  }
  return into
}

function readable(path: string): string | null {
  try {
    const buffer = readFileSync(path)
    if (buffer.length > TEXT_LIMIT || buffer.includes(0)) return null
    return buffer.toString('utf8')
  } catch {
    return null
  }
}

/** The reply, and every text file the execution added or changed relative to the task's source. */
export function defaultDeliverable(cwd: string, reply: string, sourceDir: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (reply.trim()) out['reply.md'] = reply
  let count = 0
  for (const rel of files(cwd)) {
    const text = readable(join(cwd, rel))
    if (text === null) continue
    const before = sourceDir && existsSync(join(sourceDir, rel)) ? readable(join(sourceDir, rel)) : null
    if (before === text) continue
    out[`files/${rel}`] = text
    if (++count >= FILES_LIMIT) break
  }
  return out
}

/** For a host that supplies nothing: a temporary copy of the task's source, the caller as the scope, and Pi's file and shell tools. */
export const DEFAULT_REFINE_HOST: RefineHost = {
  async prepareWorkspace({ task }) {
    const cwd = mkdtempSync(join(tmpdir(), 'harness-rollout-'))
    if (task.sourceDir && existsSync(task.sourceDir)) cpSync(task.sourceDir, cwd, { recursive: true })
    return { cwd, cleanup: async () => rmSync(cwd, { recursive: true, force: true }) }
  },
  async session({ task }) {
    return { caller: { agentId: task.scope, actor: 'Code' }, tools: { allow: ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'] } }
  }
}
