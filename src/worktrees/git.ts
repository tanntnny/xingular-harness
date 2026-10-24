// Git, run without a shell. Every configured clean/smudge/process filter is disabled so Harness
// operations never run repository-provided filter code, and git never stops to ask.
import { spawn } from 'node:child_process'

import { HarnessError } from '../core/errors'

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

export interface GitOptions {
  input?: string | Buffer
  env?: Record<string, string>
  /** Return a failed result instead of throwing. */
  allowFail?: boolean
}

const QUIET_FILTERS = ['-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', '-c', 'core.hooksPath=/dev/null']
const FILTER_KEYS = /^filter\.(.*)\.(?:clean|smudge|process|required)$/i

function configuredFilters(cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.once('error', (error) => reject(new HarnessError('git_unavailable', `Git could not be started: ${error.message}`, 'Install git and make sure it is on PATH.')))
    child.once('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8')
      if (code !== 0 && code !== 1) {
        const stderr = Buffer.concat(err).toString('utf8').trim()
        reject(new HarnessError('git_failed', `git config failed: ${stderr || `exit ${code ?? 1}`}`))
        return
      }
      const filters = new Set<string>()
      for (const key of stdout.split('\0').filter(Boolean)) {
        const match = FILTER_KEYS.exec(key)
        if (match) filters.add(match[1])
      }
      resolve([...filters].flatMap((filter) => [
        '-c', `filter.${filter}.clean=`,
        '-c', `filter.${filter}.smudge=`,
        '-c', `filter.${filter}.process=`,
        '-c', `filter.${filter}.required=false`
      ]))
    })
  })
}

export async function git(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', LC_ALL: 'C', ...options.env }
  const filters = await configuredFilters(cwd, env)
  return new Promise((resolve, reject) => {
    const input = options.input
    const hasInput = input !== undefined && input.length > 0
    const child = spawn('git', [...QUIET_FILTERS, ...filters, ...args], {
      cwd,
      env,
      stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe']
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout!.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr!.on('data', (chunk: Buffer) => err.push(chunk))
    child.once('error', (error) => reject(new HarnessError('git_unavailable', `Git could not be started: ${error.message}`, 'Install git and make sure it is on PATH.')))
    child.once('close', (code) => {
      const result = { code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }
      if (result.code !== 0 && !options.allowFail) {
        reject(new HarnessError('git_failed', `git ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`))
        return
      }
      resolve(result)
    })
    if (hasInput && child.stdin) {
      child.stdin.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(new HarnessError('git_failed', `git ${args.join(' ')} could not read input: ${error.message}`))
      })
      child.stdin.end(input)
    }
  })
}

/** The trimmed standard output of a git command that must succeed. */
export async function gitText(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<string> {
  return (await git(cwd, args, options)).stdout.trim()
}

/** NUL-separated output as a list, without the empty last entry. */
export function nulList(text: string): string[] {
  return text.split('\0').filter(Boolean)
}
