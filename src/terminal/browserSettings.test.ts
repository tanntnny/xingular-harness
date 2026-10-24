import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { writeBrowserConfig } from '../browser/config'
import { createHarness, type Harness } from '../harness'
import { rootWithProject } from '../../tests/helpers'
import { SOCKET_ENV, TOKEN_ENV, socketCall, type SocketConnection } from './client'

const open: Harness[] = []
afterEach(async () => { for (const harness of open.splice(0)) await harness.close() })

async function setup() {
  const root = rootWithProject()
  const stateDir = mkdtempSync(join(tmpdir(), 'terminal-browser-settings-'))
  const harness = createHarness({
    dataRoot: root,
    stateDir,
    secrets: memorySecretStore(),
    assets: { node: '/opt/node', cli: '/opt/harness/cli.js', piExtension: '/opt/harness/terminal-pi.js', openTui: '/opt/harness/terminal-opentui.js' }
  })
  open.push(harness)
  const account = harness.accounts.create('Main', 'apiKey').accounts[0]!
  const launch = await harness.terminals.prepare({
    sessionId: 'browser-settings-terminal', accountId: account.id, cwd: root,
    sessionFolder: join(root, 'sessions', 'browser-settings-terminal')
  })
  const connection: SocketConnection = { socket: String(launch.env[SOCKET_ENV]), token: String(launch.env[TOKEN_ENV]) }
  const { key } = await socketCall<{ key: string }>(connection, 'control.claim')
  const call = <T>(method: string, params: Record<string, unknown> = {}) => socketCall<T>(connection, method, params, 5_000, key)
  return { connection, call, harness, stateDir }
}

describe('browser settings in a terminal', () => {
  it('requires terminal control and changes only private-address access', async () => {
    const { connection, call, harness, stateDir } = await setup()
    writeBrowserConfig(stateDir, { headed: true, allowedDomains: ['example.com'] })

    await expect(socketCall(connection, 'terminal.browser.config')).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(socketCall(connection, 'terminal.browser.configure', { allowPrivate: true })).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(call('terminal.browser.config')).resolves.toEqual({ allowPrivate: false })
    await expect(call('terminal.browser.configure', { allowPrivate: true })).resolves.toEqual({ allowPrivate: true })
    expect(harness.world.browserConfig()).toMatchObject({ allowPrivate: true, headed: true, allowedDomains: ['example.com'] })

    await expect(call('terminal.browser.configure', { allowPrivate: 'yes' })).rejects.toMatchObject({ code: 'invalid_request' })
    expect(harness.world.browserConfig()).toMatchObject({ allowPrivate: true, headed: true, allowedDomains: ['example.com'] })
  })
})
