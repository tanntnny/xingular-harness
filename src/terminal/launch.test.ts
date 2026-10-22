import { describe, expect, it } from 'vitest'

import { terminalCommandFiles } from './launch'

describe('terminal launch commands', () => {
  it('provides Git Bash and native Windows launchers for each Harness command', () => {
    expect(terminalCommandFiles('win32', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Harness\\cli.js', 'xagent-wiki', 'wiki'))
      .toEqual([
        { name: 'xagent-wiki', content: "#!/bin/sh\nexec '/c/Program Files/nodejs/node.exe' '/c/Harness/cli.js' wiki \"$@\"\n" },
        { name: 'xagent-wiki.cmd', content: '@echo off\r\n"%XINGULAR_HARNESS_NODE%" "%XINGULAR_HARNESS_CLI%" wiki %*\r\nexit /b %ERRORLEVEL%\r\n' }
      ])
  })
})
