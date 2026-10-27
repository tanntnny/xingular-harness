import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import { methods } from '../server/methods'
import * as proposals from './proposals'

const roots: string[] = []
const open: Harness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup() {
  const base = mkdtempSync(join(tmpdir(), 'proposals-'))
  roots.push(base)
  const root = join(base, 'data')
  const harness = createHarness({ dataRoot: root, stateDir: join(base, 'state'), secrets: memorySecretStore() })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')
  return { base, root, harness, table: methods(harness) }
}
const files = { 'extensions/guard.ts': 'export default function () {}\n', 'skills/audit/SKILL.md': '---\nname: audit\ndescription: Audit\n---\nText' }
const create = (root: string, input: unknown = files) => proposals.create(root, 'review-kit', 'Review tools', input)

it('previews deterministic content and requires the reviewed hash to reject', () => {
  const { root, table } = setup()
  const proposal = table['plugins.proposals.create']({ name: 'review-kit', description: 'Review tools', files }) as proposals.Proposal
  expect(table['plugins.proposals.preview']({ id: proposal.id })).toEqual(proposal)
  expect(create(root, Object.fromEntries(Object.entries(files).reverse())).hash).toBe(proposal.hash)
  expect(JSON.parse(proposal.manifest)).toEqual({ name: 'review-kit', version: '1.0.0', description: 'Review tools' })
  expect(table['plugins.proposals.list']({})).toHaveLength(2)
  expect(() => table['plugins.proposals.reject']({ id: proposal.id })).toThrow()
  expect(() => proposals.reject(root, proposal.id, '0'.repeat(64))).toThrow('Stale')
  expect(table['plugins.proposals.reject']({ id: proposal.id, hash: proposal.hash })).toMatchObject({ status: 'rejected' })
  expect(() => proposals.reject(root, proposal.id, proposal.hash)).toThrow('no longer pending')
  expect(existsSync(join(root, 'plugins/review-kit'))).toBe(false)
})

it('rejects hostile paths, supplied manifests, unsupported files and invalid skills', () => {
  const { root } = setup()
  for (const bad of [
    { ...files, '../escape.md': 'x' }, { ...files, '/extensions/a.ts': 'x' },
    { ...files, 'extensions/x\\y.ts': 'x' }, { ...files, 'extensions/../x.ts': 'x' },
    { ...files, 'extensions/.git/x.ts': 'x' }, { ...files, 'extensions/x.ts': '\ud800' },
    { ...files, 'extensions/x.ts': 'x'.repeat(262145) }, { ...files, 'package.json': '{"name":"review-kit"}' },
    { ...files, 'extensions/x.sh': 'x' }, { ...files, 'skills/audit/SKILL.md': '---\nname: wrong\ndescription: Audit\n---\nx' },
    { ...files, 'skills/audit/SKILL.md': '---\nname: audit\n---\nx' }, { ...files, 'extensions/guard.ts/x.ts': 'x' }
  ]) expect(() => create(root, bad)).toThrow()
  expect(() => proposals.preview(root, '../escape')).toThrow()
})

it('rejects changed content before and during asynchronous acceptance', async () => {
  const { root, harness } = setup()
  const proposal = create(root)
  const path = join(root, 'plugin-proposals', `${proposal.id}.json`)
  const alter = () => writeFileSync(path, JSON.stringify({ ...proposal, description: 'Changed' }))
  alter()
  await expect(proposals.accept(harness, proposal.id, proposal.hash)).rejects.toThrow('Stale')
  expect(() => proposals.reject(root, proposal.id, proposal.hash)).toThrow('Stale')
  writeFileSync(path, JSON.stringify(proposal))
  const pending = proposals.accept(harness, proposal.id, proposal.hash)
  alter()
  await expect(pending).rejects.toThrow('Stale')
  expect(existsSync(join(root, 'plugins/review-kit'))).toBe(false)
})

it('accepts off and untrusted, without executing code, and generates the manifest', async () => {
  const { base, root, harness, table } = setup()
  const marker = join(base, 'executed')
  const proposal = create(root, { ...files, 'extensions/guard.ts': `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'executed')\n` })
  expect(() => table['plugins.proposals.accept']({ id: proposal.id })).toThrow()
  expect(await table['plugins.proposals.accept']({ id: proposal.id, hash: proposal.hash })).toMatchObject({ status: 'accepted' })
  expect(readFileSync(join(root, 'plugins/review-kit/package.json'), 'utf8')).toBe(proposal.manifest)
  const plugins = await table['plugins.list']({}) as any[]
  expect(plugins.find((plugin) => plugin.id === 'package:review-kit')).toMatchObject({ trust: 'untrusted', attachment: { global: false } })
  expect(harness.plugins.trust.list()).toEqual([])
  expect(existsSync(marker)).toBe(false)
  await expect(proposals.accept(harness, proposal.id, proposal.hash)).rejects.toThrow('no longer pending')
})

it('never overwrites an existing destination', async () => {
  const { root, harness } = setup()
  const proposal = create(root)
  mkdirSync(join(root, 'plugins/review-kit'), { recursive: true })
  writeFileSync(join(root, 'plugins/review-kit/keep'), 'original')
  await expect(proposals.accept(harness, proposal.id, proposal.hash)).rejects.toThrow()
  expect(readFileSync(join(root, 'plugins/review-kit/keep'), 'utf8')).toBe('original')
  expect(proposals.preview(root, proposal.id).status).toBe('pending')
})
