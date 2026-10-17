import { describe, expect, it } from 'vitest'

import { resolvePiCommand, terminalCommandFiles } from './launch'

describe('terminal launch commands', () => {
  it.each(['darwin', 'linux', 'win32'] as const)('runs the owned Harness frontend with the active Node runtime on %s', (platform) => {
    const launch = resolvePiCommand({ platform, node: 'C:\\Program Files\\nodejs\\node.exe', cli: '/bundle/cli.js' })

    expect(launch.program).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(launch.argsPrefix).toEqual(['/bundle/cli.js', 'terminal-frontend'])
  })

  it('keeps an explicitly configured executable even on Windows', () => {
    expect(resolvePiCommand({ platform: 'win32', node: 'node.exe', cli: '/bundle/cli.js', programOverride: () => 'C:\\Tools\\pi.exe' }))
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
