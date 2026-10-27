import { describe, expect, it } from 'vitest'

import { resolveShell, shellArguments, shellLabel } from './shell'
import { createWorkspaceShellTool } from './workspaceBashTool'

const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', SystemRoot: 'C:\\Windows' }

function windows(files: string[], path: Record<string, string> = {}) {
  return resolveShell('win32', { env, exists: (candidate) => files.includes(candidate), onPath: (name) => path[name] ?? null })
}

describe('Windows shell resolution', () => {
  it('prefers Git Bash in Program Files', () => {
    const shell = windows(['C:\\Program Files\\Git\\bin\\bash.exe'], { 'bash.exe': 'D:\\msys\\bash.exe', 'pwsh.exe': 'C:\\pwsh.exe' })
    expect(shell).toEqual({ kind: 'bash', executable: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['-c'] })
    expect(shellLabel(shell!)).toBe('Git Bash')
  })

  it('uses a bash.exe on PATH but never the WSL launcher', () => {
    expect(windows([], { 'bash.exe': 'D:\\msys\\bash.exe' })?.executable).toBe('D:\\msys\\bash.exe')
    expect(windows([], { 'bash.exe': 'C:\\Windows\\System32\\bash.exe', 'powershell.exe': 'C:\\ps.exe' })?.kind).toBe('powershell')
  })

  it('falls back to PowerShell 7, then Windows PowerShell', () => {
    expect(windows([], { 'pwsh.exe': 'C:\\tools\\pwsh.exe', 'powershell.exe': 'C:\\ps.exe' })?.executable).toBe('C:\\tools\\pwsh.exe')
    expect(windows(['C:\\Program Files\\PowerShell\\7\\pwsh.exe'])?.executable).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    const builtIn = windows(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'])
    expect(builtIn?.kind).toBe('powershell')
    expect(shellLabel(builtIn!)).toBe('PowerShell')
    expect(shellArguments(builtIn!, 'Get-Location').at(-1)).toMatch(/UTF8 \} catch \{\}\nGet-Location$/u)
  })

  it('reports no shell when nothing is installed', () => {
    expect(windows([])).toBeNull()
  })

  it('keeps Bash on POSIX systems', () => {
    expect(resolveShell('linux', { exists: (candidate) => candidate === '/usr/bin/bash' })).toEqual({ kind: 'bash', executable: '/usr/bin/bash', args: ['-c'] })
    expect(shellArguments({ kind: 'bash', executable: '/bin/bash', args: ['-c'] }, 'ls')).toEqual(['-c', 'ls'])
  })
})

describe('the shell tool', () => {
  const tool = (description: string) => ({ name: description === 'ps' ? 'powershell' : 'bash', description, execute: async () => ({}) })
  const factories = { createBashTool: () => tool('bash'), createPowerShellTool: () => tool('ps') }
  const operations = { exec: async () => ({ exitCode: 0 }) }

  it('keeps the name bash when PowerShell runs the commands', () => {
    const shell = { kind: 'powershell' as const, executable: 'C:\\ps.exe', args: [] }
    const result = createWorkspaceShellTool(factories, 'C:\\work', operations, shell, 'win32')
    expect(result.name).toBe('bash')
    expect(result.description).toMatch(/^ps On this machine commands run in PowerShell\. .*asks for approval/u)
  })

  it('adds no Windows note on other systems', () => {
    const result = createWorkspaceShellTool(factories, '/work', operations, { kind: 'bash', executable: '/bin/bash', args: ['-c'] }, 'darwin')
    expect(result.description).toMatch(/^bash Workspace writes/u)
  })
})
