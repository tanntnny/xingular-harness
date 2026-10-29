import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The installed command's state directory, selected by its interactive profile when it has one.
// Development keeps its own data, approvals and trust, but signs in as these accounts, so one
// OAuth sign-in serves both launches.
function installedStateDir() {
  const fallback = join(homedir(), '.xingular-harness', 'state')
  try {
    const selected = JSON.parse(readFileSync(join(homedir(), '.xingular-harness', 'profile.json'), 'utf8')).stateDir
    return typeof selected === 'string' && isAbsolute(selected) ? selected : fallback
  } catch {
    return fallback
  }
}

const args = process.argv.slice(2)
const defaults = []
const devRoot = join(homedir(), '.xingular-harness-dev')

if (!args.includes('--data')) defaults.push('--data', join(devRoot, 'data'))
if (!args.includes('--state')) defaults.push('--state', join(devRoot, 'state'))
if (!args.includes('--account-state')) defaults.push('--account-state', installedStateDir())

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const result = spawnSync(process.execPath, [cli, ...args, ...defaults], { stdio: 'inherit' })

if (result.error) throw result.error
process.exitCode = result.status ?? 1
