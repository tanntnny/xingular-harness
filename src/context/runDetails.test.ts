import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { dataRoot } from '../../tests/helpers'
import { freezeRun } from '../capabilities/runSnapshot'
import { runRecordSchema, type RunEvent } from '../sessions/contracts'
import { appendEvent, saveRun, updateRun } from '../sessions/runStore'
import { runDetails } from './runDetails'
import { createEnv } from '../core/env'
import { dispatch } from '../tools/dispatch'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function setup() {
  const root = dataRoot()
  roots.push(root)
  saveRun(root, runRecordSchema.parse({ id: 'r', sessionId: 's', mode: 'chat', harness: 'pi', sessionType: 'structured', status: 'completed', startedAt: 'now' }))
  return root
}

function snapshot(root: string, toolsTruncated = false) {
  const event: RunEvent = { id: 'e', runId: 'r', sessionId: 's', sequence: 1, timestamp: 'now', type: 'context.snapshot', payload: { systemPrompt: '', tools: [{ name: 'read', description: '', parameters: {} }], toolsTruncated } }
  appendEvent(root, event)
}

test('projects recorded facts without treating contributions as activated plugins', () => {
  const root = setup()
  freezeRun(root, 'r', {}, { version: 1, tools: ['other'], connectors: ['mail'], contributions: ['plugin'] })
  snapshot(root)
  expect(runDetails(root, 'r')).toEqual({ runId: 'r', status: 'completed', mode: null, model: null, effort: null, variantScope: null, variantVersion: null, workspaceRoot: null, tools: ['read'], connectors: ['mail'], skills: null, plugins: null })
})

test('records only successful named skill loads for the active run', () => {
  const root = setup()
  updateRun(root, 'r', (run) => { run.status = 'running'; run.loadedSkills = [] })
  // Settled records cannot be reopened; create a separate active run instead.
  saveRun(root, runRecordSchema.parse({ id: 'active', sessionId: 's', mode: 'chat', harness: 'pi', sessionType: 'structured', status: 'running', startedAt: 'now', loadedSkills: [] }))
  const dir = join(root, 'variant')
  mkdirSync(join(dir, 'skills', 'triage'), { recursive: true })
  writeFileSync(join(dir, 'skills', 'triage', 'SKILL.md'), 'Triage instructions')
  const call = (name: string) => dispatch(createEnv(root), { runId: 'active' }, 'skill.load', { name }, { variantDir: dir })
  call('')
  call('missing')
  expect(runDetails(root, 'active').skills).toEqual([])
  expect(call('skills/triage')).toContain('Triage instructions')
  call('triage')
  expect(runDetails(root, 'active').skills).toEqual(['triage'])
  expect(runDetails(root, 'r').skills).toEqual([])
})

test('distinguishes absent and truncated snapshots from known empty capabilities', () => {
  const root = setup()
  expect(runDetails(root, 'r')).toMatchObject({ tools: null, connectors: null })
  freezeRun(root, 'r', {}, { version: 1, tools: [], connectors: [], contributions: [] })
  snapshot(root, true)
  expect(runDetails(root, 'r')).toMatchObject({ tools: null, connectors: [] })
  expect(() => runDetails(root, 'missing')).toThrow()
})
