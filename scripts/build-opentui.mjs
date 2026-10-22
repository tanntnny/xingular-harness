import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = join(root, 'dist')
const frontend = join(dist, 'terminal-opentui.js')
mkdirSync(dist, { recursive: true })

const bun = process.env.XINGULAR_HARNESS_BUN || 'bun'
const probe = spawnSync(bun, ['--version'], { encoding: 'utf8' })
if (probe.status !== 0) {
  console.error(`Bun was not found at ${bun}. The OpenTUI terminal is the only Harness terminal, so the build cannot produce ${frontend}. Install Bun or set XINGULAR_HARNESS_BUN.`)
  process.exit(1)
}

const result = spawnSync(bun, [join(root, 'scripts/build-opentui.bun.ts')], { stdio: 'inherit', cwd: root })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
