import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { invalid, notFound } from '../core/errors'
import { newId, now, readJson, safeId, writeJson } from '../core/fs'
import type { CallerContext } from './caller'
import type { Job } from './maintenance'
import type { MaintenanceRequest } from './maintainer'
import { captureHashes, parseProposalSet, type ProposalSet, type RegistryProposal, type Evidence, type Trigger } from './proposals'
import { looksSecret } from './secrets'
import * as store from './store'

export type CurationInput = Job
  | { kind: 'proposal'; namespace: string; proposals: ProposalSet; caller: CallerContext }
  | { kind: 'registry'; proposal: RegistryProposal; caller: CallerContext }
  | { kind: 'plugin'; proposal: unknown; caller: CallerContext }
export interface CurationJob {
  id: string
  key: string
  input: CurationInput
  status: 'queued' | 'running' | 'completed' | 'failed' | 'rejected' | 'needs_user'
  createdAt: string
  updatedAt: string
  runId: string | null
  reason: string
  hashes: [string, string][]
  prepared?: { request: MaintenanceRequest; evidence: Evidence; namespace: string; trigger: Trigger }
  receipt: { operationId: string | null; notes: string[]; parked: number; flagged: number } | null
}

const directory = (root: string): string => join(store.wikiDir(root), 'maintenance-jobs')
export function listCuration(root: string): CurationJob[] {
  let names: string[] = []
  try { names = readdirSync(directory(root)) } catch { return [] }
  return names.filter((name) => name.endsWith('.json')).flatMap((name) => {
    const job = readJson<CurationJob>(join(directory(root), name))
    return job && typeof job.id === 'string' && job.input && typeof job.input.kind === 'string' ? [job] : []
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
export function curationJob(root: string, id: string): CurationJob {
  const job = readJson<CurationJob>(join(directory(root), `${safeId(id)}.json`))
  if (!job) throw notFound('Maintenance job')
  return job
}
export function saveCuration(root: string, job: CurationJob): CurationJob {
  writeJson(join(directory(root), `${safeId(job.id)}.json`), { ...job, updatedAt: now() })
  return job
}
export function enqueueCuration(root: string, input: CurationInput): CurationJob {
  if (input.kind === 'proposal') input = { ...input, proposals: parseProposalSet(input.proposals) }
  if (Buffer.byteLength(JSON.stringify(input)) > 256 * 1024) throw invalid('The proposal is larger than 256 KiB.')
  if (looksSecret(JSON.stringify(input))) throw invalid('The proposal contains text that looks like a credential.')
  const captured = captureHashes(store.wikiDir(root))
  const revisions = input.kind === 'consolidate' ? input.blockIds.map(id => [id, captured.get(id)]) : undefined
  const key = createHash('sha256').update(JSON.stringify({ input, revisions })).digest('hex')
  const existing = listCuration(root).find((job) => job.key === key)
  if (existing) return existing
  const timestamp = now()
  return saveCuration(root, { id: newId(), key, input, status: 'queued', createdAt: timestamp, updatedAt: timestamp, runId: null, reason: '', hashes: [...captured], receipt: null })
}
export function requireCurator(context: CallerContext): void {
  if (context.vaultAccess !== 'curator' || !context.runId) throw invalid('This operation needs a curator capability issued by the host for this run.')
}
