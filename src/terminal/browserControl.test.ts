import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { createHarness, type Harness } from '../harness'
import * as pluginApi from '../plugins/api'
import { materialise } from '../variant/materialise'
import { commit, seed } from '../variant/store'
import { BrowserControl, isWithinBoundary } from './browserControl'

const fixtures: { harness: Harness; root: string }[] = []
function symlink(target: string, path: string, directory = false): void {
  symlinkSync(target, path, process.platform === 'win32' ? directory ? 'junction' : 'file' : directory ? 'dir' : 'file')
}
afterEach(async () => { for (const { harness, root } of fixtures.splice(0)) { await harness.close(); rmSync(root, { recursive: true, force: true }) } })
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'browser-control-'))
  const data = join(root, 'data')
  const harness = createHarness({ dataRoot: data, stateDir: join(root, 'state'), secrets: memorySecretStore() })
  fixtures.push({ harness, root })
  const files = { 'systemprompt.md': 'Review changes.', 'guardrails.md': '', 'memory.md': '', 'tool_guidance.md': '' }
  seed(data, 'scope', files)
  const pinned = materialise(data, { scope: 'scope' })
  const browser = new BrowserControl({ root: data, cwd: root, pinned, writable: true, apps: harness.apps, hub: harness.hub,
    plugins: () => pluginApi.list(harness) })
  return { root, data, harness, files, browser, pinned }
}

describe('terminal browser service boundary', () => {
  it('uses Windows path separators when checking canonical containment', () => {
    expect(isWithinBoundary('C:\\registry', 'C:\\registry\\skills\\review\\SKILL.md', win32)).toBe(true)
    expect(isWithinBoundary('C:\\registry', 'C:\\outside\\secret.md', win32)).toBe(false)
  })

  it('keeps the prepared variant separate from later commits and reads both by resource id', async () => {
    const { data, files, pinned, browser } = setup()
    const latest = commit(data, 'scope', { ...files, 'systemprompt.md': 'Different instructions.' }, { kind: 'edit' })
    const snapshot = await browser.snapshot()
    expect(snapshot.variant).toEqual({ scope: 'scope', pinned: pinned.fingerprint, latest: latest.fingerprint, writable: true })
    expect(snapshot.items.find(item => item.id === 'variant:systemprompt.md')?.status).toBe('Changed in latest')
    expect((await browser.read('variant:systemprompt.md')).content).toBe('Review changes.')
    expect((await browser.read('variant:systemprompt.md', true)).content).toBe('Different instructions.')
    await expect(browser.read('variant:../../state/secrets.json')).rejects.toThrow('no inspectable content')
  })

  it('imports a bounded local skill into the reusable library without adding it to the variant', async () => {
    const { root, browser } = setup()
    const folder = join(root, 'review')
    mkdirSync(folder)
    writeFileSync(join(folder, 'SKILL.md'), '---\nname: review\ndescription: Review changes.\n---\nCheck the diff.')
    browser.importSkill('review')
    const snapshot = await browser.snapshot()
    const item = snapshot.items.find(item => item.componentId === 'skills/review')
    expect(item).toMatchObject({ status: 'Library only', added: false })
    expect((await browser.read(item!.id)).content).toContain('Check the diff.')
    expect(snapshot.variant.latest).toBe(snapshot.variant.pinned)
    expect(() => browser.importSkill('review')).toThrow('already exists')
  })

  it('rejects symlinked imports and previews replaced with symbolic links', async () => {
    const { root, browser, data } = setup()
    const folder = join(root, 'review')
    mkdirSync(folder)
    writeFileSync(join(folder, 'SKILL.md'), '---\nname: review\ndescription: Review.\n---\nRead.')
    symlink(join(root, 'data'), join(folder, 'escape'), true)
    expect(() => browser.importSkill('review')).toThrow('symbolic links')
    rmSync(join(folder, 'escape'))
    browser.importSkill('review')
    const skill = join(data, 'registry/skills/review')
    rmSync(skill, { recursive: true })
    symlink(folder, skill, true)
    await expect(browser.read('library:skills/review')).rejects.toThrow('outside its owner folder')
  })

  it('enumerates symlinked library folders but rejects previews escaping the registry', async () => {
    const { root, data, browser } = setup()
    const external = join(root, 'external')
    const skill = join(external, 'skills', 'escape')
    mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: escape\ndescription: External skill.\n---\nOutside the registry.')
    const link = join(data, 'registry', 'skills', 'escape')
    mkdirSync(join(data, 'registry', 'skills'), { recursive: true })
    symlink(skill, link, true)

    const snapshot = await browser.snapshot()
    expect(snapshot.items).toContainEqual(expect.objectContaining({ id: 'library:skills/escape' }))
    await expect(browser.read('library:skills/escape')).rejects.toThrow('outside its owner folder')
  })

  it('does not expose stored credentials, connect, or infer live state from a saved check', async () => {
    const { browser, harness } = setup()
    const saved = await harness.apps.save({ name: 'Example', kind: 'remote', url: 'https://example.test/mcp', auth: 'headers', headers: { Authorization: 'SECRET_VALUE' }, enabled: false, global: true })
    const test = vi.spyOn(harness.apps, 'test')
    const snapshot = await browser.snapshot()
    expect(JSON.stringify(snapshot)).not.toContain('SECRET_VALUE')
    expect(snapshot.items.find(item => item.connectionId === saved.id)?.status).toBe('Disabled')
    expect(test).not.toHaveBeenCalled()
    await expect(browser.connection('test', { id: 'unknown' })).rejects.toThrow('Unknown connection')
  })
})
