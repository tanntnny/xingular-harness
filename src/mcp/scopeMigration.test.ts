import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import * as attachments from '../plugins/attachments'
import { migrateConnectionScopes, rollbackConnectionScopeMigration } from './scopeMigration'

const roots: string[] = []
function fixture(): { root: string; stateDir: string; sessionPath: string } {
  const base = mkdtempSync(join(tmpdir(), 'xingular-scope-migration-'))
  roots.push(base)
  const root = join(base, 'data')
  const stateDir = join(base, 'state')
  mkdirSync(join(root, 'config'), { recursive: true })
  mkdirSync(join(root, 'sessions', 'agent'), { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  const sessionPath = join(root, 'sessions', 'agent', 'thread.json')
  writeFileSync(sessionPath, Buffer.from('{ "session": "keep these bytes\\nexactly" }\n'))
  mkdirSync(join(root, 'agents', 'agent-a'), { recursive: true })
  writeFileSync(join(root, 'agents', 'agent-a', 'agent.md'), Buffer.from('tools: [read, bash, mcp_call_tool]\n'))
  return { root, stateDir, sessionPath }
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('connector scope migration', () => {
  it('moves scopes, verifies assignments, keeps session bytes, and restores exact backups', () => {
    const { root, stateDir, sessionPath } = fixture()
    const sessionHash = digest(sessionPath)
    const agentToolsPath = join(root, 'agents', 'agent-a', 'agent.md')
    const agentToolsHash = digest(agentToolsPath)
    const connectionBytes = Buffer.from(`[{"id":"linear","name":"Linear","kind":"remote","enabled":true,"global":true,"agentIds":["agent-a"],"excludedAgentIds":["agent-b"],"projectIds":["project-a"],"excludedProjectIds":["project-b"],"url":"https://mcp.example"}]\n`)
    const oldAttachmentsBytes = Buffer.from('{"version":1,"global":{"on":["existing"],"off":[]},"agents":{},"projects":{},"settings":{"keep":{"x":1}}}\n')
    const connectionsPath = join(stateDir, 'connections.json')
    const attachmentsPath = join(root, 'config', 'plugin-attachments.json')
    writeFileSync(connectionsPath, connectionBytes)
    writeFileSync(attachmentsPath, oldAttachmentsBytes)

    const result = migrateConnectionScopes(root, stateDir)
    expect(result).toMatchObject({ status: 'complete', connectionCount: 1, scopeAssignmentCount: 5, hadAttachments: true })
    const saved = JSON.parse(readFileSync(connectionsPath, 'utf8'))[0]
    expect(saved).toMatchObject({ id: 'linear', url: 'https://mcp.example' })
    for (const key of ['global', 'agentIds', 'excludedAgentIds', 'projectIds', 'excludedProjectIds']) expect(saved).not.toHaveProperty(key)

    const migrated = attachments.load(root)
    expect(migrated.global.on).toContain('connected-apps/connection/linear')
    expect(migrated.agents['agent-a'].on).toContain('connected-apps/connection/linear')
    expect(migrated.agents['agent-b'].off).toContain('connected-apps/connection/linear')
    expect(migrated.projects['project-a'].on).toContain('connected-apps/connection/linear')
    expect(migrated.projects['project-b'].off).toContain('connected-apps/connection/linear')
    expect(digest(sessionPath)).toBe(sessionHash)
    expect(digest(agentToolsPath)).toBe(agentToolsHash)
    expect(readFileSync(join(stateDir, 'connections.pre-capability-scope.json'))).toEqual(connectionBytes)
    expect(readFileSync(join(root, 'config', 'plugin-attachments.pre-capability-scope.json'))).toEqual(oldAttachmentsBytes)

    rollbackConnectionScopeMigration(root, stateDir)
    expect(readFileSync(connectionsPath)).toEqual(connectionBytes)
    expect(readFileSync(attachmentsPath)).toEqual(oldAttachmentsBytes)
    expect(digest(sessionPath)).toBe(sessionHash)
    expect(digest(agentToolsPath)).toBe(agentToolsHash)
  })

  it('is idempotent after completion without rewriting session data', () => {
    const { root, stateDir, sessionPath } = fixture()
    writeFileSync(join(stateDir, 'connections.json'), '[{"id":"linear","global":false}]\n')
    const before = digest(sessionPath)
    const first = migrateConnectionScopes(root, stateDir)
    expect(migrateConnectionScopes(root, stateDir)).toEqual(first)
    expect(digest(sessionPath)).toBe(before)
  })
})
