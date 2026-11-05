import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { sharedDir } from '../accounts/env'
import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import { methods } from '../server/methods'
import { rootWithProject, writeFile } from '../../tests/helpers'
import { normalizeSource } from './install'
import type { Plugin } from './types'

const open: Harness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})

function setup() {
  const root = rootWithProject()
  const base = mkdtempSync(join(tmpdir(), 'install-'))
  const harness = createHarness({ dataRoot: root, stateDir: join(base, 'state'), secrets: memorySecretStore() })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')
  const agentDir = harness.accounts.context(harness.accounts.resolve(null, null)).configDir
  const table = methods(harness)
  const call = <T>(method: string, params: Record<string, unknown> = {}) => table[method](params) as Promise<T>
  const loaded = async () => {
    const loading = await harness.plugins.loading({ cwd: base, agentDir, caller: {} })
    return { extensions: loading.extensionPaths.map((path) => path.replace(`${base}/`, '')), skills: loading.skillPaths.map((path) => path.replace(`${base}/`, '')) }
  }
  return { harness, root, base, call, loaded }
}

function kit(folder: string): void {
  writeFile(join(folder, 'package.json'), JSON.stringify({ name: 'review-kit', description: 'Review helpers.', version: '1.0.0' }))
  writeFile(join(folder, 'extensions/guard.ts'), 'export default function () {}\n')
  writeFile(join(folder, 'skills/audit/SKILL.md'), '---\nname: audit\ndescription: Audit a change.\n---\nSteps.\n')
}

describe('installing a package', () => {
  it('reads a name as an npm package, keeps a folder or an address as it is, and refuses a relative path', () => {
    expect(normalizeSource(' pi-tools ')).toBe('npm:pi-tools')
    expect(normalizeSource('npm:@scope/pi-tools@1.0.0')).toBe('npm:@scope/pi-tools@1.0.0')
    expect(normalizeSource('git:github.com/example/pi-tools@v1')).toBe('git:github.com/example/pi-tools@v1')
    expect(normalizeSource('https://github.com/example/pi-tools')).toBe('https://github.com/example/pi-tools')
    expect(() => normalizeSource('https://github.com/example/pi-tools/tree/main/skills/audit')).toThrow('Install https://github.com/example/pi-tools as a package')
    expect(() => normalizeSource('https://github.com/example/pi-tools/blob/main/skills/audit/SKILL.md')).toThrow('.agents/skills')
    expect(() => normalizeSource('https://gitlab.com/example/pi-tools/-/tree/main/skills/audit')).toThrow('https://gitlab.com/example/pi-tools as a package')
    expect(normalizeSource('/tmp/kit/')).toBe('/tmp/kit')
    expect(() => normalizeSource('./kit')).toThrow('whole path')
    expect(() => normalizeSource('  ')).toThrow()
  })

  it('arrives switched off and untrusted, and loads only once it is both switched on and trusted', async () => {
    const { harness, base, call, loaded } = setup()
    kit(join(base, 'kit'))
    const after = await call<Plugin[]>('plugins.install', { source: join(base, 'kit') })
    const plugin = after.find((candidate) => candidate.id === 'package:review-kit')!
    expect(plugin).toMatchObject({ source: 'package', version: '1.0.0', runsCode: true, trust: 'untrusted', install: { kind: 'settings', source: join(base, 'kit') }, attachment: { global: false } })
    expect(plugin.contributions.map((entry) => `${entry.kind}:${entry.name}:${entry.state}`)).toEqual(['code:guard.ts:off', 'skill:audit:off'])
    // It is named in the settings every account shares, as `pi install` would have done.
    expect(JSON.parse(readFileSync(join(sharedDir(harness.accounts.dir), 'settings.json'), 'utf8')).packages).toEqual([join(base, 'kit')])
    expect(await loaded()).toEqual({ extensions: [], skills: [] })

    // Switched on, its text loads; its code still waits for trust.
    await call('plugins.attach', { id: plugin.id })
    expect(await loaded()).toEqual({ extensions: [], skills: ['kit/skills/audit/SKILL.md'] })
    const trusted = await call<Plugin[]>('plugins.trust', { hash: plugin.code!.hash })
    expect(trusted.find((candidate) => candidate.id === plugin.id)).toMatchObject({ trust: 'trusted' })
    expect(await loaded()).toEqual({ extensions: ['kit/extensions/guard.ts'], skills: ['kit/skills/audit/SKILL.md'] })

    // A stale fingerprint is refused, and changed code waits again.
    writeFileSync(join(base, 'kit/extensions/guard.ts'), 'export default function () { /* changed */ }\n')
    await expect(call('plugins.trust', { hash: plugin.code!.hash })).rejects.toThrow('changed since it was shown')
    expect((await loaded()).extensions).toEqual([])

    const removed = await call<Plugin[]>('plugins.remove', { pluginId: plugin.id })
    expect(removed.some((candidate) => candidate.id === plugin.id)).toBe(false)
    expect(JSON.parse(readFileSync(join(sharedDir(harness.accounts.dir), 'settings.json'), 'utf8')).packages ?? []).toEqual([])
    // A folder that was installed in place is not deleted with its entry.
    expect(existsSync(join(base, 'kit/package.json'))).toBe(true)
    expect(await loaded()).toEqual({ extensions: [], skills: [] })
  })

  it('does not remove a different package when a marketplace receipt has the same plugin id', async () => {
    const { root, base, call, harness } = setup()
    kit(join(base, 'kit'))
    const installed = await call<Plugin[]>('plugins.install', { source: join(base, 'kit') })
    const plugin = installed.find(candidate => candidate.id === 'package:review-kit')!
    const entry = {
      id: 'community/review-kit', title: 'Review Kit', description: 'Review helpers.', publisher: 'Community', license: 'MIT', version: '1.0.0',
      category: 'plugin', channel: 'community', tags: [], requires: {}, sourceUrl: 'https://example.com/review-kit',
      delivery: { kind: 'pi-package', source: 'npm:review-kit@1.0.0' }
    }
    mkdirSync(join(root, 'hub'), { recursive: true })
    writeFileSync(join(root, 'hub/installed.json'), JSON.stringify([{ entry, installedAt: '2026-10-20T08:00:00.000Z', resourceIds: [plugin.id], document: null }]))
    const listed = await call<Plugin[]>('plugins.list')
    const missing = listed.find(candidate => candidate.install?.source === 'npm:review-kit@1.0.0')!
    expect(missing.id).not.toBe(plugin.id)
    expect(missing.description).toContain('Needs attention')
    await expect(call('plugins.update', { pluginId: missing.id })).rejects.toThrow('managed by Hub')
    await call('plugins.remove', { pluginId: missing.id })
    expect((await call<Plugin[]>('plugins.list')).some(candidate => candidate.id === plugin.id)).toBe(true)
    expect(existsSync(join(base, 'kit/package.json'))).toBe(true)
    expect((await harness.hub.list()).installed).toEqual([])
  })

  it('keeps an undiscoverable marketplace package visible and removes its configured source', async () => {
    const { root, call, harness } = setup()
    const source = 'npm:missing-review@1.0.0'
    const settingsPath = join(sharedDir(harness.accounts.dir), 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ packages: [{ source, skills: ['skills/*'] }] }))
    const entry = {
      id: 'community/missing-review', title: 'Missing review', description: 'Review helpers.', publisher: 'Community', license: 'MIT', version: '1.0.0',
      category: 'plugin', channel: 'community', tags: [], requires: {}, sourceUrl: 'https://example.com/review', delivery: { kind: 'pi-package', source }
    }
    mkdirSync(join(root, 'hub'), { recursive: true })
    writeFileSync(join(root, 'hub/installed.json'), JSON.stringify([{ entry, installedAt: '2026-10-20', resourceIds: ['package:missing-review'], document: null }]))
    const missing = (await call<Plugin[]>('plugins.list')).find(plugin => plugin.install?.source === source)!
    expect(missing).toMatchObject({ id: 'package:missing-review', path: null, attachment: null })
    expect((await harness.hub.list()).installed[0].state).toBe('incomplete')
    await call('plugins.remove', { pluginId: missing.id })
    expect((JSON.parse(readFileSync(settingsPath, 'utf8')).packages ?? [])).toEqual([])
    expect((await harness.hub.list()).installed).toEqual([])
  })

  it('attributes the built-in TUI skill and removes it from resolved capabilities when detached', async () => {
    const { call } = setup()
    const before = await call<Plugin[]>('plugins.list')
    expect(before.find(plugin => plugin.id === 'tui-inspection')?.contributions).toEqual([expect.objectContaining({ id: 'tui-inspection/skill/tui-inspection', state: 'on' })])
    const active = await call<{ contributions: string[] }>('capabilities.resolve')
    expect(active.contributions).toContain('tui-inspection/skill/tui-inspection')
    await call('plugins.detach', { id: 'tui-inspection' })
    const inactive = await call<{ contributions: string[] }>('capabilities.resolve')
    expect(inactive.contributions).not.toContain('tui-inspection/skill/tui-inspection')
  })

  it('keeps the built-in REA skill off until attached and removes it again when detached', async () => {
    const { call } = setup()
    const id = 'rea/skill/reverse-engineer-anything'
    const before = await call<Plugin[]>('plugins.list')
    expect(before.find(plugin => plugin.id === 'rea')?.contributions).toEqual(expect.arrayContaining([expect.objectContaining({ id, state: 'off' }), expect.objectContaining({ id: 'rea/connection/builtin-rea', state: 'off' })]))
    expect((await call<{ contributions: string[] }>('capabilities.resolve')).contributions).not.toContain(id)
    await call('plugins.attach', { id: 'rea' })
    expect((await call<{ contributions: string[] }>('capabilities.resolve')).contributions).toContain(id)
    await call('plugins.detach', { id: 'rea' })
    expect((await call<{ contributions: string[] }>('capabilities.resolve')).contributions).not.toContain(id)
  })

  it('refuses a folder that is not there, and a plugin that was not installed', async () => {
    const { base, call } = setup()
    await expect(call('plugins.install', { source: join(base, 'missing') })).rejects.toThrow('does not exist')
    await expect(call('plugins.remove', { pluginId: 'wiki' })).rejects.toThrow('was not installed as a package')
    await expect(call('plugins.update', { pluginId: 'nope' })).rejects.toThrow()
  })

  it('finds a package kept as a folder beside the data, and moves it to the trash when removed', async () => {
    const { root, call, loaded, harness } = setup()
    // Trust has been asked per package before this folder appears, so its code waits.
    harness.plugins.trust.adopt([])
    kit(join(root, 'plugins/review-kit'))
    mkdirSync(join(root, 'plugins/.hidden'), { recursive: true })
    const plugins = await call<Plugin[]>('plugins.list')
    const plugin = plugins.find((candidate) => candidate.id === 'package:review-kit')!
    expect(plugin).toMatchObject({ trust: 'untrusted', install: { kind: 'folder', source: join(root, 'plugins/review-kit') }, attachment: { global: true } })
    expect((await loaded()).skills.some((path) => path.endsWith('plugins/review-kit/skills/audit/SKILL.md'))).toBe(true)
    expect((await loaded()).extensions).toEqual([])
    await expect(call('plugins.update', { pluginId: plugin.id })).rejects.toThrow('is a folder on this machine')

    await call('plugins.remove', { pluginId: plugin.id })
    expect(existsSync(join(root, 'plugins/review-kit'))).toBe(false)
    expect(readdirSync(join(root, 'trash/plugins')).some((name) => name.startsWith('review-kit-'))).toBe(true)
  })
})
