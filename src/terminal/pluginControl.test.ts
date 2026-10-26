import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import { runPluginsCli } from '../plugins/cli'
import type { Plugin } from '../plugins/types'
import { rootWithProject, writeFile } from '../../tests/helpers'
import { SOCKET_ENV, TOKEN_ENV, socketCall, type SocketConnection } from './client'
import { menuRows, rowActions, runPluginsMenu, type MenuUi } from './pluginMenu'

const open: Harness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})

function kit(folder: string): void {
  writeFile(join(folder, 'package.json'), JSON.stringify({ name: 'review-kit', description: 'Review helpers.', version: '1.0.0' }))
  writeFile(join(folder, 'extensions/guard.ts'), 'export default function () {}\n')
  writeFile(join(folder, 'skills/audit/SKILL.md'), '---\nname: audit\ndescription: Audit a change.\n---\nSteps.\n')
}

async function session() {
  const root = rootWithProject()
  const base = mkdtempSync(join(tmpdir(), 'control-'))
  writeFile(join(root, 'registry/rules/tests.md'), '---\nname: Run tests\ndescription: Always test.\n---\nAlways run the tests.\n')
  const harness = createHarness({ dataRoot: root, stateDir: join(base, 'state'), secrets: memorySecretStore(), assets: { node: '/opt/node', cli: '/opt/harness/cli.js', piExtension: '/opt/harness/terminal-pi.js', openTui: '/opt/harness/terminal-opentui.js' } })
  open.push(harness)
  const account = harness.accounts.create('Main', 'apiKey').accounts[0]
  harness.plugins.trust.adopt([])
  kit(join(root, 'plugins/review-kit'))
  const launch = await harness.terminals.prepare({ sessionId: 'term-1', accountId: account.id, projectId: 'p1', cwd: base, sessionFolder: join(root, 'sessions', 'p1', 'term-1') })
  const connection: SocketConnection = { socket: String(launch.env[SOCKET_ENV]), token: String(launch.env[TOKEN_ENV]) }
  return { harness, root, base, connection }
}

/** A person at the terminal, answering each dialog in turn from a script. */
function person(answers: (string | boolean | undefined)[]) {
  const shown: string[] = []
  const said: string[] = []
  const ui: MenuUi = {
    select: async (title, options) => {
      shown.push(`${title} → ${options.join(' | ')}`)
      return answers.shift() as string | undefined
    },
    confirm: async (title, message) => {
      shown.push(`${title} ${message}`)
      return answers.shift() === true
    },
    notify: (message) => void said.push(message)
  }
  return { ui, shown, said }
}

describe('plugin control from a terminal session', () => {
  it("lists for anyone in the session, and changes only for the session's own extension", async () => {
    const { connection } = await session()
    const listed = await socketCall<Plugin[]>(connection, 'plugins.list')
    const plugin = listed.find((candidate) => candidate.id === 'package:review-kit')!
    expect(plugin).toMatchObject({ trust: 'untrusted' })
    // A command the model runs in the shell has the session token and nothing more.
    await expect(socketCall(connection, 'plugins.trust', { hash: plugin.code!.hash })).rejects.toThrow('Only a person at this terminal can change plugins')
    await expect(socketCall(connection, 'plugins.detach', { id: plugin.id })).rejects.toThrow('Only a person at this terminal')
    await expect(socketCall(connection, 'plugins.trust', { hash: plugin.code!.hash }, 5_000, 'guessed')).rejects.toThrow('Only a person at this terminal')

    // The extension claims the key as it loads. It is given out once.
    const { key } = await socketCall<{ key: string }>(connection, 'control.claim')
    await expect(socketCall(connection, 'control.claim')).rejects.toThrow('already claimed')
    const trusted = await socketCall<Plugin[]>(connection, 'plugins.trust', { hash: plugin.code!.hash }, 5_000, key)
    expect(trusted.find((candidate) => candidate.id === plugin.id)).toMatchObject({ trust: 'trusted' })
    // Without "everywhere", a switch from a terminal is for the session's project.
    const off = await socketCall<Plugin[]>(connection, 'plugins.detach', { id: plugin.id }, 5_000, key)
    expect(off.find((candidate) => candidate.id === plugin.id)!.attachment).toEqual({ global: true, on: { agentIds: [], projectIds: [] }, off: { agentIds: [], projectIds: ['p1'] } })
  })

  it('changes a plugin setting only for the person at the terminal, inside its range', async () => {
    const { connection } = await session()
    const keyless = { pluginId: 'web', settings: { keylessSearch: 1 } }
    await expect(socketCall(connection, 'plugins.configure', keyless)).rejects.toThrow('Only a person at this terminal')
    const { key } = await socketCall<{ key: string }>(connection, 'control.claim')
    await expect(socketCall(connection, 'plugins.configure', { pluginId: 'web', settings: { keylessSearch: 5 } }, 5_000, key)).rejects.toThrow('from 0 to 1')
    const saved = await socketCall<Plugin[]>(connection, 'plugins.configure', keyless, 5_000, key)
    expect(saved.find((plugin) => plugin.id === 'web')!.settings.find((setting) => setting.key === 'keylessSearch')!.value).toBe(1)
    const listed = await socketCall<Plugin[]>(connection, 'plugins.list')
    expect(listed.find((plugin) => plugin.id === 'web')!.settings.find((setting) => setting.key === 'keylessSearch')!.value).toBe(1)
  })

  it('walks a person through switching and trusting, and changes nothing they did not choose', async () => {
    const { harness, connection } = await session()
    const { key } = await socketCall<{ key: string }>(connection, 'control.claim')
    const call = <T>(method: string, params?: Record<string, unknown>) => socketCall<T>(connection, method, params ?? {}, 5_000, key)
    const rows = menuRows(await call<Plugin[]>('plugins.list'), 'p1')
    expect(rows.map((row) => row.label)).toEqual(['● review-kit · code not trusted', '● Browser', '○ Budget guard · runs code', '○ Lessons · runs code', '○ Output trim · runs code', '● Web', '● Web annotations'])
    expect(rowActions(rows[0], 'p1')).toEqual(['Switch off for this project', 'Switch off everywhere', 'Trust its code', 'Back'])
    const guard = rows.find((row) => row.label.startsWith('○ Budget guard'))!
    expect(rowActions(guard, null)).toEqual(['Switch on everywhere', 'Back'])
    // A part that ships with the harness needs no trust: it is the harness's own code.
    expect(rowActions(guard, 'p1')).toEqual(['Switch on for this project', 'Switch on everywhere', 'Back'])

    // Declining the trust question leaves the code untrusted; then they trust it and leave.
    const { ui, shown, said } = person(['● review-kit · code not trusted', 'Trust its code', false, '● review-kit · code not trusted', 'Trust its code', true, 'Done'])
    await runPluginsMenu(ui, call, 'p1')
    expect(shown.find((line) => line.startsWith('Trust this code?'))).toContain('extensions/guard.ts')
    expect(shown.find((line) => line.startsWith('Trust this code?'))).toContain('can do anything this app can')
    expect(said).toEqual(['Saved. It applies when this session restarts.'])
    const after = await call<Plugin[]>('plugins.list')
    expect(after.find((plugin) => plugin.id === 'package:review-kit')).toMatchObject({ trust: 'trusted' })
    expect(harness.plugins.trust.list()).toHaveLength(1)

    // Leaving at once changes nothing and says nothing.
    const idle = person([undefined])
    await runPluginsMenu(idle.ui, call, 'p1')
    expect(idle.said).toEqual([])
  })
})

describe('the plugins command', () => {
  it('lists, installs, switches, trusts only on a yes, and removes, on its own data', async () => {
    const base = mkdtempSync(join(tmpdir(), 'plugins-cli-'))
    kit(join(base, 'kit'))
    const lines: string[] = []
    const run = (argv: string[], answer?: string) => runPluginsCli([...argv, '--data', join(base, 'data'), '--state', join(base, 'state')], { home: base, cwd: base, write: (text) => void lines.push(text), ...(answer === undefined ? {} : { ask: async () => answer }) })
    const last = (): string => lines.at(-1) ?? ''

    expect(await run(['list'])).toBe(0)
    expect(last()).toMatch(/^variant\s+required\s+Variant$/m)
    expect(await run(['install', join(base, 'kit')])).toBe(0)
    expect(last()).toContain('Installed, switched off.')
    expect(last()).toContain('trust its code with "plugins trust <id>"')
    expect(await run(['list'])).toBe(0)
    expect(last()).toMatch(/^package:review-kit\s+off, code not trusted\s+review-kit$/m)

    expect(await run(['attach', 'package:review-kit'])).toBe(0)
    expect(last()).toBe('package:review-kit is on everywhere. It applies from the next session start.\n')
    // No terminal to ask on and no --yes: the files are shown and nothing is trusted.
    expect(await run(['trust', 'package:review-kit'])).toBe(1)
    expect(lines.at(-2)).toContain('extensions/guard.ts')
    expect(last()).toBe('Read the files, then run this again with --yes to trust them.\n')
    expect(await run(['trust', 'package:review-kit'], 'no')).toBe(1)
    expect(last()).toBe('Not trusted.\n')
    expect(await run(['trust', 'package:review-kit'], 'yes')).toBe(0)
    expect(await run(['show', 'package:review-kit'])).toBe(0)
    expect(last()).toContain('State: on')
    expect(last()).toContain('Code (trusted)')
    expect(last()).toContain('● skill audit (package:review-kit/skill/audit)')

    expect(await run(['detach', 'variant'])).toBe(1)
    expect(last()).toContain('Variant cannot be switched off.')
    expect(await run(['untrust', 'package:review-kit'])).toBe(0)
    expect(await run(['remove', 'package:review-kit'])).toBe(0)
    expect(await run(['show', 'package:review-kit'])).toBe(1)
    expect(await run(['nonsense'])).toBe(2)
    // The folder that was installed in place is still the person's.
    expect(existsSync(join(base, 'kit/package.json'))).toBe(true)
  })
})
