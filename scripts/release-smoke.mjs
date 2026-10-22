import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
if (!args[0]) throw new Error('Usage: npm run release:smoke -- <candidate.tgz> [--offline] [--terminal] [--keep]')
const tarball = resolve(args[0])
const scratch = mkdtempSync(join(tmpdir(), 'xingular-release-consumer-'))
const modules = join(scratch, 'node_modules')
const candidate = join(modules, '@xingular', 'harness')
const offline = args.includes('--offline')
const report = { tarball, dependencyMode: offline ? 'existing locked dependency tree' : 'fresh npm installation', checks: [] }
function run(command, arguments_, options = {}) { return execFileSync(command, arguments_, { cwd: scratch, stdio: 'inherit', timeout: 180_000, ...options }) }
try {
  const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n')
  if (entries.some(entry => !entry.startsWith('package/') || entry.split('/').includes('..'))) throw new Error('Unexpected tarball paths.')
  const pkg = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
  if (pkg.name !== '@xingular/harness' || pkg.version !== '1.0.0') throw new Error('Unexpected package identity.')
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  if (offline) {
    mkdirSync(candidate, { recursive: true })
    run('tar', ['-xzf', tarball, '--strip-components=1', '-C', candidate])
    for (const dependency of [...Object.keys(pkg.dependencies), '@types/node', 'typescript']) {
      const source = join(root, 'node_modules', dependency)
      if (!existsSync(source)) throw new Error(`Offline dependency is missing: ${dependency}`)
      const target = join(modules, dependency)
      mkdirSync(dirname(target), { recursive: true })
      symlinkSync(source, target, 'junction')
    }
  } else {
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--cache', process.env.XINGULAR_RELEASE_NPM_CACHE ?? '/private/tmp/xingular-release-npm-cache', tarball, 'typescript@5.9.3', '@types/node@22.19.1'])
  }
  report.checks.push('Candidate contents and dependency resolution')
  writeFileSync(join(scratch, 'consumer.mjs'), `
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness, memorySecretStore, Doctor } from '@xingular/harness'
import { doctorReportSchema } from '@xingular/harness/doctor/types'
import { seedVariant } from '@xingular/harness/variant/seed'
import { defaultAssets } from '@xingular/harness/terminal/terminals'
assert.equal(typeof Doctor, 'function')
assert.equal(typeof seedVariant, 'function')
const root = join(process.cwd(), 'data')
mkdirSync(root)
const harness = createHarness({ stateDir: join(process.cwd(), 'state'), dataRoot: root, secrets: memorySecretStore() })
try {
  const job = harness.doctor.start({ context: { caller: {}, cwd: root, accountId: null, model: null, tools: [] }, checks: ['account', 'runtime.storage', 'runtime.assets'] })
  const deadline = Date.now() + 15000
  while (harness.doctor.read(job.id).state === 'running') {
    assert.ok(Date.now() < deadline, 'Doctor timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const report = doctorReportSchema.parse(harness.doctor.read(job.id))
  assert.equal(report.findings.find(item => item.id === 'account').status, 'fail')
  assert.equal(report.findings.find(item => item.id === 'runtime.storage').status, 'pass')
  assert.equal(report.findings.find(item => item.id === 'runtime.assets').status, 'pass')
  assert.ok(defaultAssets().cli.endsWith('/dist/cli.js'))
  assert.equal(harness.doctor.cancel(job.id).state, 'completed')
  console.log('Packaged SDK, subpaths, isolation, assets, and Doctor passed.')
} finally { await harness.close() }
`)
  run(process.execPath, ['consumer.mjs'])
  report.checks.push('Plain Node ESM SDK, subpaths, assets and Doctor')
  writeFileSync(join(scratch, 'consumer.ts'), `import { createHarness, type DoctorReport, type VariantChoice } from '@xingular/harness'\nimport type { DoctorInput } from '@xingular/harness/doctor/types'\nconst variant: VariantChoice = { scope: 'release' }\nconst input: DoctorInput = { context: { caller: {}, cwd: '.', accountId: null, model: null, tools: [], variant } }\nconst check = (harness: ReturnType<typeof createHarness>): DoctorReport => harness.doctor.start(input)\nvoid check\n`)
  run(process.execPath, [join(modules, 'typescript', 'lib', 'tsc.js'), '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--target', 'ES2022', '--types', 'node', 'consumer.ts'])
  report.checks.push('TypeScript NodeNext consumer')
  const cli = join(candidate, 'dist', 'cli.js')
  const help = execFileSync(process.execPath, [cli, '--help'], { cwd: scratch, encoding: 'utf8' })
  if (!help.includes('xharness') || !help.includes('serve')) throw new Error('Packaged CLI help is incomplete.')
  if (execFileSync(process.execPath, [cli, '--version'], { cwd: scratch, encoding: 'utf8' }).trim() !== '1.0.0') throw new Error('Packaged CLI version is wrong.')
  report.checks.push('Packaged CLI executable and version')
  run(process.execPath, [join(root, 'scripts', 'release-server-smoke.mjs'), cli, scratch])
  report.checks.push('Packaged JSON-lines server and Doctor lifecycle')
  if (args.includes('--terminal')) {
    run('python3', [join(root, 'scripts', 'verify-terminal.py'), '--help-only', '--cli', cli, '--sizes', '100x30'], { timeout: 180_000 })
    report.checks.push('Packaged terminal in isolated PTY with loopback transport')
  }
  writeFileSync(`${tarball}.smoke.json`, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (args.includes('--keep')) console.log(`Consumer retained at ${scratch}`)
  else rmSync(scratch, { recursive: true, force: true })
}
