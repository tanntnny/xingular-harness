import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import { bundledPiCli, resolvePiCommand, terminalCommandFiles } from './launch'

describe('terminal launch commands', () => {
  it('runs the pinned Pi CLI with the active Node runtime on Windows', () => {
    const launch = resolvePiCommand({ platform: 'win32', node: 'C:\\Program Files\\nodejs\\node.exe' })

    expect(launch.program).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(launch.argsPrefix[0]).toMatch(/[\\/]node_modules[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]bundle[\\/]cli\.js$/)
  })

  it('runs the package CLI through Node for a no-model help smoke', () => {
    const result = spawnSync(process.execPath, [bundledPiCli(), '--help'], { encoding: 'utf8', timeout: 20_000 })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/usage|options|pi/i)
  })

  it('keeps an explicitly configured executable even on Windows', () => {
    expect(resolvePiCommand({ platform: 'win32', node: 'node.exe', programOverride: () => 'C:\\Tools\\pi.exe' }))
      .toEqual({ program: 'C:\\Tools\\pi.exe', argsPrefix: [] })
  })

  it('provides Git Bash and native Windows launchers for each Harness command', () => {
    expect(terminalCommandFiles('win32', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Harness\\cli.js', 'xagent-wiki', 'wiki'))
      .toEqual([
        { name: 'xagent-wiki', content: "#!/bin/sh\nexec '/c/Program Files/nodejs/node.exe' '/c/Harness/cli.js' wiki \"$@\"\n" },
        { name: 'xagent-wiki.cmd', content: '@echo off\r\n"%XINGULAR_HARNESS_NODE%" "%XINGULAR_HARNESS_CLI%" wiki %*\r\nexit /b %ERRORLEVEL%\r\n' }
      ])
  })
})
