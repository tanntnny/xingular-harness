// Moves who can reach each connected app out of the device-local connection records and into
// the data root's shared capability attachment store. The originals remain as owner-only backups.
import { chmodSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWrite, readJson, writeJson } from '../core/fs'
import * as attachments from '../plugins/attachments'
import { connectionCapabilityId, connectionSchema, type Connection } from './types'

interface MigrationRecord {
  version: 1
  status: 'attachments-written' | 'complete'
  connectionCount: number
  scopeAssignmentCount: number
  connectionsBackup: string | null
  attachmentsBackup: string | null
  hadAttachments: boolean
}

const recordPath = (root: string): string => join(root, 'config/capability-scope-migration.json')
const attachmentsPath = (root: string): string => join(root, 'config/plugin-attachments.json')
const connectionPath = (stateDir: string): string => join(stateDir, 'connections.json')
const connectionsBackupPath = (stateDir: string): string => join(stateDir, 'connections.pre-capability-scope.json')
const attachmentsBackupPath = (root: string): string => join(root, 'config/plugin-attachments.pre-capability-scope.json')

/** Scope writes are safe only after the legacy records have been copied and stripped. */
export function connectionScopeMigrationComplete(root: string): boolean {
  try {
    const marker = readJson<MigrationRecord>(recordPath(root))
    return marker?.version === 1 && marker.status === 'complete'
  } catch {
    return false
  }
}

interface ScopeRows {
  global: boolean
  agents: Map<string, boolean>
  projects: Map<string, boolean>
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function scopeRows(connection: Connection): ScopeRows {
  const agents = new Map<string, boolean>()
  const projects = new Map<string, boolean>()
  for (const id of unique([...connection.agentIds, ...connection.excludedAgentIds])) {
    agents.set(id, !connection.excludedAgentIds.includes(id))
  }
  for (const id of unique([...connection.projectIds, ...connection.excludedProjectIds])) {
    projects.set(id, !connection.excludedProjectIds.includes(id))
  }
  return { global: connection.global, agents, projects }
}

function assignmentCount(rows: ScopeRows): number {
  return 1 + rows.agents.size + rows.projects.size
}

function removeId(choices: attachments.Attachments, id: string): void {
  attachments.forgetId(choices, id)
}

function put(map: { on: string[]; off: string[] }, id: string, value: boolean): void {
  map.on = map.on.filter((item) => item !== id)
  map.off = map.off.filter((item) => item !== id)
  map[value ? 'on' : 'off'].push(id)
}

function writeRows(choices: attachments.Attachments, id: string, rows: ScopeRows): void {
  removeId(choices, id)
  put(choices.global, id, rows.global)
  for (const [scopeId, on] of rows.agents) {
    const target = (choices.agents[scopeId] ??= { on: [], off: [] })
    put(target, id, on)
  }
  for (const [scopeId, on] of rows.projects) {
    const target = (choices.projects[scopeId] ??= { on: [], off: [] })
    put(target, id, on)
  }
}

function readValue(item: { on: string[]; off: string[] } | undefined, id: string): boolean | null {
  if (item?.off.includes(id)) return false
  if (item?.on.includes(id)) return true
  return null
}

function verifyRows(choices: attachments.Attachments, id: string, expected: ScopeRows): boolean {
  if (readValue(choices.global, id) !== expected.global) return false
  for (const [scopeId, on] of expected.agents) {
    if (readValue(choices.agents[scopeId], id) !== on) return false
  }
  for (const [scopeId, on] of expected.projects) {
    if (readValue(choices.projects[scopeId], id) !== on) return false
  }
  return true
}

function backup(source: string, target: string): boolean {
  if (!existsSync(source)) return false
  if (!existsSync(target)) atomicWrite(target, readFileSync(source))
  chmodSync(target, 0o600)
  return true
}

function setPrivate(path: string): void {
  try { chmodSync(path, 0o600) } catch { /* The atomic write remains usable if chmod is unavailable. */ }
}

function stripScopes(stateDir: string): void {
  const path = connectionPath(stateDir)
  if (!existsSync(path)) return
  const stored = readJson<unknown>(path)
  if (!Array.isArray(stored)) throw new Error('Stored connector data must be a list before its scopes can be migrated.')
  const records = stored.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('A stored connector record is invalid; no scope data was removed.')
    const { global: _global, agentIds: _agentIds, projectIds: _projectIds, excludedAgentIds: _excludedAgentIds, excludedProjectIds: _excludedProjectIds, ...connection } = item as Record<string, unknown>
    return connection
  })
  writeJson(path, records)
  setPrivate(path)
}

/**
 * Runs once when a data root opens. Both source files are backed up before either is changed;
 * a stage marker makes an interrupted migration safe to finish on the next open.
 */
export function migrateConnectionScopes(root: string, stateDir: string): MigrationRecord {
  const marker = readJson<MigrationRecord>(recordPath(root))
  if (marker?.version === 1 && marker.status === 'complete') return marker

  if (marker?.version === 1 && marker.status === 'attachments-written') {
    stripScopes(stateDir)
    const complete = { ...marker, status: 'complete' as const }
    writeJson(recordPath(root), complete)
    return complete
  }

  const connectionsFile = connectionPath(stateDir)
  const hadConnections = existsSync(connectionsFile)
  const raw = hadConnections ? readJson<unknown>(connectionsFile) : []
  if (!Array.isArray(raw)) throw new Error('Stored connector data must be a list before its scopes can be migrated.')
  const parsed = raw.map((item) => {
    const result = connectionSchema.safeParse(item)
    if (!result.success) throw new Error('A stored connector record is invalid; no scope data was removed.')
    return result.data
  })
  const connectionBackup = hadConnections ? connectionsBackupPath(stateDir) : null
  const hadAttachments = existsSync(attachmentsPath(root))
  const attachmentBackup = hadAttachments ? attachmentsBackupPath(root) : null
  const migration: MigrationRecord = {
    version: 1,
    status: 'attachments-written',
    connectionCount: parsed.length,
    scopeAssignmentCount: parsed.reduce((count, connection) => count + assignmentCount(scopeRows(connection)), 0),
    connectionsBackup: connectionBackup,
    attachmentsBackup: attachmentBackup,
    hadAttachments
  }
  backup(connectionsFile, connectionBackup ?? '')
  backup(attachmentsPath(root), attachmentBackup ?? '')

  try {
    const choices = attachments.load(root)
    const expected = new Map<string, ScopeRows>()
    for (const connection of parsed) {
      const id = connectionCapabilityId(connection.id)
      const rows = scopeRows(connection)
      expected.set(id, rows)
      writeRows(choices, id, rows)
    }
    const migratedAssignments = [...expected.values()].reduce((count, rows) => count + assignmentCount(rows), 0)
    if (migratedAssignments !== migration.scopeAssignmentCount || [...expected].some(([id, rows]) => !verifyRows(choices, id, rows))) {
      throw new Error('Connector scope count check failed; the original files were restored.')
    }
    attachments.save(root, choices)
    const saved = attachments.load(root)
    if ([...expected].some(([id, rows]) => !verifyRows(saved, id, rows))) throw new Error('Connector scope count check failed after saving; the original files were restored.')
    writeJson(recordPath(root), migration)
    stripScopes(stateDir)
    const complete = { ...migration, status: 'complete' as const }
    writeJson(recordPath(root), complete)
    return complete
  } catch (error) {
    if (attachmentBackup && existsSync(attachmentBackup)) atomicWrite(attachmentsPath(root), readFileSync(attachmentBackup))
    else if (!hadAttachments && existsSync(attachmentsPath(root))) unlinkSync(attachmentsPath(root))
    if (connectionBackup && existsSync(connectionBackup)) atomicWrite(connectionsFile, readFileSync(connectionBackup))
    try { unlinkSync(recordPath(root)) } catch { /* No marker is also a valid retry state. */ }
    throw error
  }
}

/** Restores the byte-identical pre-migration files from the backups if an operator rolls back. */
export function rollbackConnectionScopeMigration(root: string, stateDir: string): void {
  const marker = readJson<MigrationRecord>(recordPath(root))
  if (!marker || marker.version !== 1) return
  if (marker.attachmentsBackup && existsSync(marker.attachmentsBackup)) atomicWrite(attachmentsPath(root), readFileSync(marker.attachmentsBackup))
  else if (!marker.hadAttachments && existsSync(attachmentsPath(root))) unlinkSync(attachmentsPath(root))
  if (marker.connectionsBackup && existsSync(marker.connectionsBackup)) atomicWrite(connectionPath(stateDir), readFileSync(marker.connectionsBackup))
  unlinkSync(recordPath(root))
}
