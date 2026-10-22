import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  bin: Record<string, string>
}
const cliSource = readFileSync(new URL('./cli.ts', import.meta.url), 'utf8')

describe('published CLI command', () => {
  it('publishes xharness as the sole executable', () => {
    expect(packageManifest.bin).toEqual({ xharness: 'dist/cli.js' })
  })

  it('documents xharness as the interactive terminal entry point', () => {
    expect(cliSource).toContain('Usage: xharness')
    expect(cliSource).not.toContain('Usage: xingular-harness')
    expect(cliSource).toContain('(no command)       Start the interactive Harness terminal')
  })
})
