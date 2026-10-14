// Where executables are found. POSIX desktop apps may start with a minimal PATH, so the login
// shell's PATH is resolved once. Windows keeps the inherited PATH and its native separator.
import { execFileSync } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, extname, isAbsolute, join } from 'node:path'

let resolved: { platform: NodeJS.Platform; inherited: string; path: string } | null = null

export function searchPath(): string {
  const platform = process.platform
  const pathKey = pathVariableName(process.env)
  const inherited = process.env[pathKey] ?? ''
  if (resolved?.platform === platform && resolved.inherited === inherited) return resolved.path
  const separator = pathSeparator(platform)
  const entries: string[] = []
  if (platform !== 'win32') {
    try {
      const output = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      // Interactive shells may print banners; the PATH is the last line.
      entries.push(...(output.split('\n').filter(Boolean).at(-1) ?? '').split(separator))
    } catch {
      // The inherited PATH and the usual folders still apply.
    }
  }
  entries.push(...inherited.split(separator))
  if (platform !== 'win32') {
    const home = homedir()
    if (home) entries.push(...['.local/bin', '.bun/bin', '.npm-global/bin', '.cargo/bin'].map((folder) => join(home, folder)))
    entries.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin')
  }
  const path = [...new Set(entries.filter(Boolean))].join(separator)
  resolved = { platform, inherited, path }
  return path
}

/** The inherited PATH key, preserving Windows' existing capitalization. */
export function pathVariableName(environment: NodeJS.ProcessEnv): string {
  return Object.keys(environment).find((name) => name.toLowerCase() === 'path') ?? 'PATH'
}

/** A child environment with a directory prepended using the selected platform's PATH rules. */
export function prependSearchPath(directory: string, existing: string, environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const values = [directory, existing].filter(Boolean)
  return { [pathVariableName(environment)]: values.join(pathSeparator(platform)) }
}

function pathSeparator(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : delimiter
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The executable `name` resolves to: itself when absolute, else the first match on the search path. */
export function findBinary(name: string): string | null {
  const platform = process.platform
  const suffixes = platform === 'win32' && !extname(name)
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : []
  const names = [name, ...suffixes.map((suffix) => `${name}${suffix}`)]
  if (isAbsolute(name)) {
    for (const candidate of names) if (isExecutable(candidate)) return candidate
    return null
  }
  for (const directory of searchPath().split(pathSeparator(platform))) {
    for (const candidateName of names) {
      const candidate = join(directory, candidateName)
      if (isExecutable(candidate)) return candidate
    }
  }
  return null
}
