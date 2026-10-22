function bashPath(path: string): string {
  const drive = /^([a-z]):[\\/](.*)$/i.exec(path)
  if (drive) return `/${drive[1].toLowerCase()}/${drive[2].replaceAll('\\', '/')}`
  if (path.startsWith('\\\\')) return `//${path.slice(2).replaceAll('\\', '/')}`
  return path
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Files Pi's Git Bash shell and native Windows shells use to call Harness subcommands. */
export function terminalCommandFiles(platform: NodeJS.Platform, node: string, cli: string, name: string, mode: string): Array<{ name: string; content: string }> {
  const shellNode = platform === 'win32' ? bashPath(node) : node
  const shellCli = platform === 'win32' ? bashPath(cli) : cli
  const files = [{
    name,
    content: `#!/bin/sh\nexec ${shellQuote(shellNode)} ${shellQuote(shellCli)} ${mode} "$@"\n`
  }]
  if (platform === 'win32') {
    files.push({
      name: `${name}.cmd`,
      content: `@echo off\r\n"%XINGULAR_HARNESS_NODE%" "%XINGULAR_HARNESS_CLI%" ${mode} %*\r\nexit /b %ERRORLEVEL%\r\n`
    })
  }
  return files
}
