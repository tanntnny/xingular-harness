import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const defaults = []
const devRoot = join(homedir(), '.xingular-harness-dev')

if (!args.includes('--data')) defaults.push('--data', join(devRoot, 'data'))
if (!args.includes('--state')) defaults.push('--state', join(devRoot, 'state'))

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const result = spawnSync(process.execPath, [cli, ...args, ...defaults], { stdio: 'inherit' })

if (result.error) throw result.error
process.exitCode = result.status ?? 1
