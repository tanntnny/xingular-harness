import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBashTool } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveWorkspaceRoot } from './workspace'
import { formatBashCommandForApproval, withWorkspaceWriteScope } from './workspaceBashTool'
import { createWorkspaceBashOperations } from './workspaceSandbox'

const fixtures: string[] = []
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('workspace Bash tool scope', () => {
  it('quotes terminal controls and bidirectional characters in approval details', () => {
    expect(formatBashCommandForApproval('echo \u001b[2J\u202e')).toBe('"echo \\u001b[2J\\u202e"')
  })

  it('exposes an optional scope and requests approval before an outside command runs', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'harness-workspace-bash-tool-')))
    fixtures.push(base)
    const rootFolder = join(base, 'workspace')
    mkdirSync(rootFolder)
    const root = resolveWorkspaceRoot(rootFolder)
    const outside = join(base, 'outside.txt')
    const requests: unknown[] = []
    const operations = createWorkspaceBashOperations(root, {
      requestWorkspaceWriteScope: async (request) => {
        requests.push(request)
        return true
      }
    })
    const tool = withWorkspaceWriteScope(createBashTool(root, { operations }))
    const parameters = tool.parameters as { properties: Record<string, unknown> }

    expect(parameters.properties.workspaceWriteScope).toBeDefined()
    const execute = tool as unknown as {
      execute(id: string, input: unknown, signal?: AbortSignal, onUpdate?: unknown, context?: unknown): Promise<unknown>
    }
    await execute.execute('outside-call', { command: `printf approved > '${outside}'`, workspaceWriteScope: 'outside' })

    expect(requests).toHaveLength(1)
    expect(readFileSync(outside, 'utf8')).toBe('approved')
  })

  it('returns a clear error without running an outside command when approval is denied', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'harness-workspace-bash-denied-')))
    fixtures.push(base)
    const rootFolder = join(base, 'workspace')
    mkdirSync(rootFolder)
    const root = resolveWorkspaceRoot(rootFolder)
    const outside = join(base, 'denied.txt')
    let requests = 0
    const operations = createWorkspaceBashOperations(root, {
      requestWorkspaceWriteScope: async () => {
        requests += 1
        return false
      }
    })
    const tool = withWorkspaceWriteScope(createBashTool(root, { operations })) as unknown as {
      execute(id: string, input: unknown, signal?: AbortSignal, onUpdate?: unknown, context?: unknown): Promise<unknown>
    }

    await expect(tool.execute('denied-call', { command: `printf denied > '${outside}'`, workspaceWriteScope: 'outside' }))
      .rejects.toThrow('Bash was not run')
    expect(requests).toBe(1)
    expect(existsSync(outside)).toBe(false)
  })
})
