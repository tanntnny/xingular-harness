// The shell the Bash tool runs commands in. POSIX systems use Bash. Windows uses Git Bash when it
// is installed and PowerShell otherwise, so a fresh machine can run commands with nothing extra.
import { accessSync, constants, statSync } from 'node:fs'
import { win32 } from 'node:path'

import { findBinary } from './path'

export type ShellKind = 'bash' | 'powershell'

export interface Shell {
  kind: ShellKind
  executable: string
  /** Arguments placed before the command text. */
  args: readonly string[]
}

export interface ShellLookup {
  env?: NodeJS.ProcessEnv
  /** Whether a file exists at an absolute path. */
  exists?: (path: string) => boolean
  /** The first match for an executable name on the search path. */
  onPath?: (name: string) => string | null
}

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'] as const
// Windows PowerShell writes the console code page by default; ask for UTF-8 like Pi does.
const POWERSHELL_UTF8 = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n'

let cached: Shell | null | undefined

/** The shell for this machine, resolved once. Null when none was found. */
export function hostShell(): Shell | null {
  if (cached === undefined) cached = resolveShell(process.platform)
  return cached
}

export function resolveShell(platform: NodeJS.Platform, lookup: ShellLookup = {}): Shell | null {
  const env = lookup.env ?? process.env
  const exists = lookup.exists ?? isFile
  const onPath = lookup.onPath ?? findBinary

  if (platform !== 'win32') {
    const executable = ['/bin/bash', '/usr/bin/bash'].find((candidate) => exists(candidate))
    return executable ? { kind: 'bash', executable, args: ['-c'] } : null
  }

  const gitBash = [env.ProgramFiles, env['ProgramFiles(x86)']]
    .filter((folder): folder is string => Boolean(folder))
    .map((folder) => win32.join(folder, 'Git', 'bin', 'bash.exe'))
    .find((candidate) => exists(candidate))
  if (gitBash) return { kind: 'bash', executable: gitBash, args: ['-c'] }

  const bashOnPath = onPath('bash.exe')
  if (bashOnPath && !isWslLauncher(bashOnPath, env)) return { kind: 'bash', executable: bashOnPath, args: ['-c'] }

  const existing = (folder: string | undefined, ...parts: string[]): string | null => {
    if (!folder) return null
    const candidate = win32.join(folder, ...parts)
    return exists(candidate) ? candidate : null
  }
  // PowerShell 7 first; Windows PowerShell ships with every supported Windows version.
  const powershell = onPath('pwsh.exe')
    ?? existing(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe')
    ?? onPath('powershell.exe')
    ?? existing(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return powershell ? { kind: 'powershell', executable: powershell, args: POWERSHELL_ARGS } : null
}

/** The full argument list that runs `command` in `shell`. */
export function shellArguments(shell: Shell, command: string): string[] {
  return [...shell.args, shell.kind === 'powershell' ? `${POWERSHELL_UTF8}${command}` : command]
}

export function shellLabel(shell: Shell): string {
  if (shell.kind === 'powershell') return 'PowerShell'
  return /\\git\\/iu.test(shell.executable) ? 'Git Bash' : 'Bash'
}

// System32\bash.exe starts WSL, a separate Linux system that does not see Windows paths the same
// way and needs its command on stdin. It is not a usable Bash for this tool.
function isWslLauncher(path: string, env: NodeJS.ProcessEnv): boolean {
  const normalized = win32.normalize(path).toLowerCase()
  const systemRoot = env.SystemRoot
  if (systemRoot) {
    return ['System32', 'Sysnative'].some((folder) => normalized === win32.join(systemRoot, folder, 'bash.exe').toLowerCase())
  }
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/u.test(normalized)
}

function isFile(path: string): boolean {
  try {
    accessSync(path, constants.F_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}
