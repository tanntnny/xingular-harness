import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  bin: Record<string, string>
}
const packageLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as {
  packages: Record<string, { bin?: Record<string, string> }>
}
const cliSource = readFileSync(new URL('./cli.ts', import.meta.url), 'utf8')

describe('published CLI command', () => {
  it('publishes xagent as the sole executable', () => {
    expect(packageManifest.bin).toEqual({ xagent: 'dist/cli.js' })
    expect(packageLock.packages[''].bin).toEqual(packageManifest.bin)
  })

  it('documents xagent as the interactive terminal entry point', () => {
    expect(cliSource).toContain('Usage: xagent')
    expect(cliSource).not.toContain('Usage: xharness')
    expect(cliSource).toContain('(no command)       Start the interactive Harness terminal')
  })
})
