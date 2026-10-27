import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const report = { package: `${pkg.name}@${pkg.version}`, local: [], registry: 'unverified', trustedPublisher: 'Requires package-owner verification of tanntnny/xingular-harness, release.yml, and direct publication enabled.' }
let failed = false
const check = (name, ok) => { report.local.push({ name, ok }); if (!ok) failed = true }
check('Expected package/version/license', pkg.name === '@xingular/harness' && /^\d+\.\d+\.\d+(?:-unstable\.\d+)?$/.test(pkg.version) && pkg.license === 'Apache-2.0')
check('Working tree is clean', !execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).trim())
if (process.argv.includes('--tagged')) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const tag = execFileSync('git', ['rev-parse', `v${pkg.version}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
  check('Release tag matches HEAD', head === tag)
}
try {
  const response = await fetch('https://registry.npmjs.org/@xingular%2fharness', { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}; package ownership/bootstrap must be verified.`)
  const metadata = await response.json()
  const used = Object.hasOwn(metadata.versions ?? {}, pkg.version) || Object.hasOwn(metadata.time ?? {}, pkg.version)
  report.registry = used ? `${pkg.version} has already been used; publication must stop.` : `${pkg.version} is unused.`
  report.currentTags = metadata['dist-tags'] ?? {}
  if (used) failed = true
} catch {
  report.registry = 'Unverified: the npm registry could not be checked. Publication must stop until this succeeds.'
  failed = true
}
console.log(JSON.stringify(report, null, 2))
if (failed) process.exitCode = 1
