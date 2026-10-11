// Where executables are found. A desktop application starts with a minimal PATH, so the login
// shell's PATH is resolved once and used for everything the harness launches.
import { execFileSync } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

let resolved: string | null = null

export function searchPath(): string {
  if (resolved !== null) return resolved
  const entries: string[] = []
  try {
    const output = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    // Interactive shells may print banners; the PATH is the last line.
    entries.push(...(output.split('\n').filter(Boolean).at(-1) ?? '').split(delimiter))
  } catch {
    // The inherited PATH and the usual folders still apply.
  }
  entries.push(...(process.env.PATH ?? '').split(delimiter))
  const home = homedir()
  if (home) entries.push(...['.local/bin', '.bun/bin', '.npm-global/bin', '.cargo/bin'].map((folder) => join(home, folder)))
  entries.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin')
  resolved = [...new Set(entries.filter(Boolean))].join(delimiter)
  return resolved
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The executable `name` resolves to: itself when absolute, else the first match on the search path. */
export function findBinary(name: string): string | null {
  if (isAbsolute(name)) return isExecutable(name) ? name : null
  for (const directory of searchPath().split(delimiter)) {
    const candidate = join(directory, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}
