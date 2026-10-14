import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { HarnessError } from '../core/errors'
import { findBinary } from '../core/path'

const PI_PACKAGE = '@earendil-works/pi-coding-agent'

export interface PiCommand {
  program: string
  argsPrefix: string[]
}

/** Resolve the Pi package's declared command instead of depending on its POSIX npm shim. */
export function bundledPiCli(): string {
  const require = createRequire(import.meta.url)
  for (const nodeModules of require.resolve.paths(PI_PACKAGE) ?? []) {
    const directory = join(nodeModules, ...PI_PACKAGE.split('/'))
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: unknown
        bin?: unknown
      }
      if (manifest.name === PI_PACKAGE) {
        const executable = typeof manifest.bin === 'string'
          ? manifest.bin
          : manifest.bin && typeof manifest.bin === 'object' && typeof (manifest.bin as Record<string, unknown>).pi === 'string'
            ? (manifest.bin as Record<string, string>).pi
            : null
        if (!executable) throw new Error('the package does not declare its pi command')
        const cli = resolve(directory, executable)
        if (!existsSync(cli)) throw new Error(`the declared command does not exist at ${cli}`)
        return cli
      }
    } catch {
      continue
    }
  }

  throw new HarnessError('harness_unavailable', `The bundled ${PI_PACKAGE} package does not expose a usable pi command. Reinstall the Harness package and try again.`)
}

export function resolvePiCommand(options: {
  platform: NodeJS.Platform
  node: string
  programOverride?: () => string | null
}): PiCommand {
  if (options.programOverride) {
    const program = options.programOverride()
    if (!program) throw new HarnessError('harness_unavailable', 'The Pi CLI was not found on PATH.')
    return { program, argsPrefix: [] }
  }
  if (options.platform === 'win32') return { program: options.node, argsPrefix: [bundledPiCli()] }
  const program = findBinary('pi')
  if (!program) throw new HarnessError('harness_unavailable', 'The Pi CLI was not found on PATH.')
  return { program, argsPrefix: [] }
}

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
