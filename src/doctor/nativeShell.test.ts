import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHarness, type Harness } from '../harness'
import { memorySecretStore } from '../accounts/secrets'
import { workspaceSandboxBackend } from '../core/workspaceSandbox'
import { listRuns, readEvents } from '../sessions/runStore'
import type { DoctorReport } from './types'

const resources: { harness: Harness; root: string }[] = []
afterEach(async () => { for (const { harness, root } of resources.splice(0)) { await harness.close(); rmSync(root, { recursive: true, force: true }) } })

function setup(policy = {}) {
  const root = mkdtempSync(join(tmpdir(), 'doctor-shell-test-'))
  const data = join(root, 'data')
  mkdirSync(data)
  const harness = createHarness({ stateDir: join(root, 'state'), secrets: memorySecretStore(), policy })
  harness.open(data)
  resources.push({ harness, root })
  return { harness, root, context: { caller: {}, cwd: root, accountId: null as string | null, model: null as string | null, tools: ['bash'] } }
}

async function wait(harness: Harness, report: DoctorReport) {
  await vi.waitFor(() => expect(harness.doctor.read(report.id).state).not.toBe('running'), { timeout: 15_000 })
  return harness.doctor.read(report.id)
}

async function live(harness: Harness, context: Parameters<Harness['doctor']['start']>[0]['context']) {
  const report = await wait(harness, harness.doctor.start({ context, mode: 'live', checks: ['native.bash'], confirmed: true }))
  return report.findings.find(item => item.id === 'native.bash')!
}

const shellEvents = (harness: Harness) => {
  const run = listRuns(harness.env.root, {})[0]
  return run ? readEvents(harness.env.root, run.id).filter(event => event.type === 'tool.started' || event.type === 'tool.completed') : []
}

// Bash is delegated to Pi on Windows, and the write-boundary sandbox is what lets a call run at
// all elsewhere; the expectations follow whichever is true on the machine running the suite.
const backend = workspaceSandboxBackend()
const localExpected = process.platform === 'win32' ? 'unverified' : backend ? 'pass' : 'fail'
const liveExpected = process.platform === 'win32' ? 'unverified' : backend ? 'pass' : 'blocked'

describe('native shell diagnostic', () => {
  it('reports the shell and the sandbox a real Bash call needs, without running anything', async () => {
    const { harness, context } = setup()
    const report = await wait(harness, harness.doctor.start({ context, checks: ['native.bash'] }))
    const finding = report.findings.find(item => item.id === 'native.bash')!
    expect(finding.verification).toBe('local')
    expect(finding.status).toBe(localExpected)
    if (process.platform !== 'win32') expect(finding.evidence).toContain('bash')
    expect(listRuns(harness.env.root, {})).toHaveLength(0)
  })

  it('runs one harness-written command through the path a Bash call takes, in a recorded diagnostic run', async () => {
    const { harness, context } = setup()
    const finding = await live(harness, context)
    expect(finding.verification).toBe('live')
    expect(finding.status).toBe(liveExpected)
    if (process.platform === 'win32') return
    expect(listRuns(harness.env.root, {})[0]?.trigger).toBe('doctor')
    expect(shellEvents(harness).map(event => `${event.type}:${(event.payload as { name?: string }).name}`)).toEqual(['tool.started:bash', 'tool.completed:bash'])
  })

  it('reports a policy refusal as blocked instead of running the command', async () => {
    const { harness, context } = setup({ scope: async () => ({ allowed: false, reason: 'Refused for this test' }) })
    const finding = await live(harness, context)
    if (process.platform === 'win32') expect(finding.status).toBe('unverified')
    else {
      expect(finding.status).toBe('blocked')
      expect(finding.evidence).toContain('Refused for this test')
      expect(shellEvents(harness)).toHaveLength(0)
    }
  })

  it('says the shell was not exercised when the workspace boundary refuses before it starts', async () => {
    const { harness, root, context } = setup()
    // A hard link out of the working folder makes the write-boundary sandbox refuse before Bash runs.
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'alias-source'), 'content')
    linkSync(join(workspace, 'alias-source'), join(root, 'alias-elsewhere'))
    const finding = await live(harness, { ...context, cwd: workspace })
    if (process.platform === 'win32') expect(finding.status).toBe('unverified')
    else {
      expect(finding.status).toBe('blocked')
      expect(finding.evidence).toContain('hard-link alias')
      expect(finding.evidence).toContain('not exercised')
    }
  })
})
