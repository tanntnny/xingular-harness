import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (pkg.name !== '@xingular/harness' || !/^\d+\.\d+\.\d+$/.test(pkg.version) || pkg.license !== 'Apache-2.0') throw new Error('Unexpected release identity, version or license.')
const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).trim()
if (status) throw new Error('Release candidates must be built from a clean committed tree.')
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
const output = resolve(root, process.argv[2] ?? `outputs/releases/${pkg.version}-${stamp}`)
const filename = `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`
if (existsSync(join(output, filename))) throw new Error('A candidate already exists at this location. Choose a new output directory.')
mkdirSync(output, { recursive: true })
execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output, '--cache', process.env.XINGULAR_RELEASE_NPM_CACHE ?? '/private/tmp/xingular-release-npm-cache'], { cwd: root, encoding: 'utf8' }))[0]
const files = packed.files.map(file => file.path)
if (!(packed.files.find(file => file.path === 'dist/cli.js')?.mode & 0o111)) throw new Error('The CLI is not executable in the candidate.')
for (const required of ['LICENSE', 'NOTICE.md', 'THIRD_PARTY_LICENSES.md', 'dist/cli.js', 'dist/terminal-opentui.js', 'dist/terminal-pi.js', 'dist/sdk/index.js', 'dist/sdk/index.d.ts']) {
  if (!files.includes(required)) throw new Error(`The candidate is missing ${required}.`)
}
if (files.some(file => /(?:^|\/)(?:src|tests|node_modules|outputs|external|\.git)(?:\/|$)|\.test\.|\.map$/.test(file))) throw new Error('Development files entered the candidate.')
const tarball = join(output, packed.filename)
const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
writeFileSync(join(output, 'candidate.json'), JSON.stringify({ name: pkg.name, version: pkg.version, tarball, sha256, integrity: packed.integrity, size: packed.size, unpackedSize: packed.unpackedSize, commit, dirty: false, files }, null, 2) + '\n')
writeFileSync(join(output, 'SHA256SUMS'), `${sha256}  ${packed.filename}\n`)
console.log(`Release candidate: ${tarball}`)
console.log(`SHA-256: ${sha256}`)
