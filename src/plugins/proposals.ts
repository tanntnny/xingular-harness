import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { invalid, notFound } from '../core/errors'
import * as frontmatter from '../core/frontmatter'
import { now, readJson, safeId, safeRelative, writeJson } from '../core/fs'
import type { Harness } from '../harness'
import { ensureAdopted, list as listPlugins } from './api'
import * as attachments from './attachments'
import { packageCode } from './trust'
import type { Found } from './discover'

const MAX_FILES = 100
const MAX_FILE_BYTES = 256 * 1024
const MAX_TOTAL_BYTES = 1024 * 1024
const dir = (root: string) => join(root, 'plugin-proposals')
const pathOf = (root: string, id: string) => join(dir(root), `${safeId(id)}.json`)

export interface Proposal {
  id: string
  name: string
  description: string
  files: Record<string, string>
  manifest: string
  hash: string
  createdAt: string
  status: 'pending' | 'accepted' | 'rejected'
  decidedAt?: string
}

function validate(name: unknown, description: unknown, input: unknown): Pick<Proposal, 'name' | 'description' | 'files' | 'manifest' | 'hash'> {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw invalid('Plugin name must be lowercase letters, digits, underscores or hyphens.')
  if (typeof description !== 'string' || !description.trim() || Buffer.byteLength(description, 'utf8') > 4096 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(description)) throw invalid('Description must be non-empty valid text of at most 4096 bytes.')
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Files must be a path to text object.')
  const entries = Object.entries(input)
  if (!entries.length || entries.length > MAX_FILES) throw invalid('A proposal must contain between 1 and 100 files.')
  const files: Record<string, string> = Object.create(null)
  let total = 0
  for (const [path, content] of entries) {
    if (typeof content !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(content)) throw invalid('Each file must be valid UTF-8 text.')
    if (path.includes('\\') || path.length > 240 || /[\x00-\x1f\x7f]/.test(path) || safeRelative(path) !== path || path.split('/').some((part) => part === 'node_modules' || part === '.git')) throw invalid('Invalid proposal file path.')
    if (!/^(?:README\.md|extensions\/[A-Za-z0-9_./-]+\.(?:ts|js|mjs)|skills\/[A-Za-z0-9_./-]+\.md|prompts\/[A-Za-z0-9_./-]+\.md|agents\/[A-Za-z0-9_./-]+\.md|themes\/[A-Za-z0-9_./-]+\.json)$/.test(path)) throw invalid('Unsupported proposal file type or location.')
    if (path.startsWith('skills/') && path.endsWith('/SKILL.md')) {
      if (!/^skills\/[A-Za-z0-9_-]+\/SKILL\.md$/.test(path)) throw invalid('Skill files must be in skills/<name>/SKILL.md.')
      const front = frontmatter.parse(content)?.front
      if (front?.name !== path.split('/')[1] || typeof front.description !== 'string' || !front.description.trim()) throw invalid('Skill frontmatter needs a matching name and a non-empty description.')
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_FILE_BYTES || (total += bytes) > MAX_TOTAL_BYTES) throw invalid('Proposal files exceed the size limit.')
    files[path] = content
  }
  for (const path of Object.keys(files)) if (Object.keys(files).some((other) => other.startsWith(`${path}/`))) throw invalid('A file cannot also be a directory.')
  const manifest = `${JSON.stringify({ name, version: '1.0.0', description }, null, 2)}\n`
  const hash = createHash('sha256').update(JSON.stringify([name, description, manifest, Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)])).digest('hex')
  return { name, description, files, manifest, hash }
}

export function create(root: string, name: unknown, description: unknown, files: unknown): Proposal {
  const valid = validate(name, description, files)
  const proposal: Proposal = { id: randomUUID(), ...valid, createdAt: now(), status: 'pending' }
  writeJson(pathOf(root, proposal.id), proposal)
  return proposal
}

export function preview(root: string, id: string): Proposal {
  const proposal = readJson<Proposal>(pathOf(root, id))
  if (!proposal) throw notFound('Proposal')
  const valid = validate(proposal.name, proposal.description, proposal.files)
  if (proposal.id !== id || !['pending', 'accepted', 'rejected'].includes(proposal.status)) throw invalid('Invalid stored proposal.')
  return { ...proposal, ...valid }
}

export function list(root: string): Proposal[] {
  let names: string[]
  try { names = readdirSync(dir(root)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names.filter((name) => /^[a-f0-9-]+\.json$/.test(name)).sort().map((name) => preview(root, name.slice(0, -5)))
}

function reviewed(proposal: Proposal, hash: string): void {
  if (proposal.status !== 'pending') throw invalid('Proposal is no longer pending.')
  if (!/^[a-f0-9]{64}$/.test(hash) || proposal.hash !== hash) throw invalid('Stale proposal review; preview it again.')
}

export function reject(root: string, id: string, hash: string): Proposal {
  const proposal = preview(root, id)
  reviewed(proposal, hash)
  const rejected: Proposal = { ...proposal, status: 'rejected', decidedAt: now() }
  writeJson(pathOf(root, id), rejected)
  return rejected
}

export async function accept(harness: Harness, id: string, hash: string): Promise<Proposal> {
  const root = harness.env.root
  const initial = preview(root, id)
  reviewed(initial, hash)
  await ensureAdopted(harness)
  const existing = await listPlugins(harness, {})
  const proposal = preview(root, id)
  reviewed(proposal, hash)
  const pluginId = `package:${proposal.name}`
  if (existing.some((plugin) => plugin.id === pluginId)) throw invalid('A plugin with this name already exists.')
  const parent = join(root, 'plugins')
  const destination = join(parent, proposal.name)
  mkdirSync(parent, { recursive: true })
  const stage = join(parent, `.proposal-${randomUUID()}`)
  mkdirSync(stage)
  let reserved = false
  try {
    for (const [path, content] of Object.entries(proposal.files)) {
      const target = join(stage, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, { flag: 'wx' })
    }
    writeFileSync(join(stage, 'package.json'), proposal.manifest, { flag: 'wx' })
    const found: Found = { kind: 'extension', path: stage, origin: 'package', project: false, packageRoot: stage, source: stage, enabled: true }
    const code = packageCode([found]).get(stage)!
    if (harness.plugins.trust.has(code.hash)) throw invalid('Identical package code is already trusted; change it before accepting.')
    // Reserve the destination exclusively. Renaming over our empty directory publishes the whole package.
    mkdirSync(destination)
    reserved = true
    const choices = attachments.load(root)
    for (const scope of [choices.global, ...Object.values(choices.agents), ...Object.values(choices.projects)]) {
      scope.on = scope.on.filter((entry) => entry !== pluginId && !entry.startsWith(`${pluginId}/`))
      scope.off = scope.off.filter((entry) => entry !== pluginId && !entry.startsWith(`${pluginId}/`))
    }
    attachments.set(choices, [pluginId], {}, false, true)
    attachments.save(root, choices)
    renameSync(stage, destination)
    reserved = false
    const accepted: Proposal = { ...proposal, status: 'accepted', decidedAt: now() }
    writeJson(pathOf(root, id), accepted)
    harness.bus.emit({ type: 'plugins.changed' })
    return accepted
  } finally {
    rmSync(stage, { recursive: true, force: true })
    if (reserved) { try { rmdirSync(destination) } catch { /* Do not remove another writer's files. */ } }
  }
}
