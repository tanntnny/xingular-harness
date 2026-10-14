import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Bus } from '../core/bus'
import { Harness } from '../harness'
import { memorySecretStore } from '../accounts/secrets'
import * as registry from '../skills/registry'
import { Hub } from './hub'
import { hubCatalogSchema, hubEntrySchema, type HubEntry } from './schema'
import { runHubMenu } from '../terminal/hubMenu'
import { SessionSocket } from '../terminal/socket'
import { HarnessError } from '../core/errors'
import { runHubCli } from './cli'

const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })
function entry(kind: 'document' | 'registry' = 'document', content = '{"message":"data only"}'): HubEntry {
  return hubEntrySchema.parse({ id: 'example/review', title: 'Review', description: 'A reviewed item.', publisher: 'Example', license: 'MIT', version: '1.0.0', category: kind === 'document' ? 'preset' : 'skill', channel: 'community', tags: [], requires: {}, sourceUrl: 'https://github.com/example/review', delivery: { kind, ...(kind === 'registry' ? { registryKind: 'skills' } : {}), url: 'https://raw.githubusercontent.com/example/review/main/payload.json', sha256: createHash('sha256').update(content).digest('hex'), bundled: content } })
}
function fixture(items: HubEntry[], fetcher?: typeof fetch) {
  const root = mkdtempSync(join(tmpdir(), 'hub-test-')); folders.push(root)
  const harness = { dataRoot: join(root, 'data'), stateDir: join(root, 'state'), env: { root: join(root, 'data') }, bus: new Bus() } as Harness
  const hub = new Hub(harness, { catalog: { schemaVersion: 1, entries: items }, fetch: fetcher })
  return { hub, harness, root: harness.env.root }
}
const skill = (name = 'review', path = 'SKILL.md') => JSON.stringify({ items: [{ name, files: [{ path, encoding: 'utf8', content: '---\nname: review\ndescription: Review evidence.\n---\n\nRead sources.' }] }] })

describe('Hub installation', () => {
  it('stores documents inertly, idempotently, and checks their digest on read', async () => {
    const { hub, root } = fixture([entry()])
    const receipt = await hub.install('example/review', '1.0.0')
    expect(receipt.resourceIds).toEqual([])
    expect(await hub.install('example/review', '1.0.0')).toEqual(receipt)
    expect(hub.readDocument('example/review', '1.0.0').content).toContain('data only')
    expect(existsSync(join(root, 'config', 'plugin-attachments.json'))).toBe(false)
    writeFileSync(join(root, 'hub', 'documents', receipt.document!), '{"edited":true}')
    expect(() => hub.readDocument('example/review', '1.0.0')).toThrow('differs')
  })
  it('imports complete skills disabled and refuses overwriting local files', async () => {
    const { hub, root } = fixture([entry('registry', skill())])
    const receipt = await hub.install('example/review', '1.0.0')
    expect(receipt.resourceIds).toEqual(['skills/review'])
    expect(registry.enabledFor(root, null)).toEqual([])
    const content = readFileSync(join(root, 'registry', 'skills', 'review', 'SKILL.md'), 'utf8')
    const collision = { ...entry('registry', skill()), id: 'other/review' }
    const another = new Hub(({ dataRoot: root, env: { root }, stateDir: join(root, 'state'), bus: new Bus() }) as Harness, { catalog: { schemaVersion: 1, entries: [collision] } })
    await expect(another.install(collision.id, collision.version)).rejects.toThrow('already exists')
    expect(readFileSync(join(root, 'registry', 'skills', 'review', 'SKILL.md'), 'utf8')).toBe(content)
  })
  it.each(['../escape', 'folder/../../escape', 'C:/escape', '.hidden/SKILL.md'])('rejects registry path %s before writing', async (path) => {
    const { hub, root } = fixture([entry('registry', skill('review', path))])
    await expect(hub.install('example/review', '1.0.0')).rejects.toThrow()
    expect(registry.list(root)).toEqual([])
    expect(existsSync(join(root, 'hub', 'installed.json'))).toBe(false)
  })
  it('imports prompts and rules as single Markdown files, disabled', async () => {
    for (const kind of ['prompts', 'rules'] as const) {
      const item = entry('registry', JSON.stringify({ items: [{ name: 'review', files: [{ path: 'CONTENT.md', encoding: 'utf8', content: '# Review\nRead evidence.' }] }] }))
      if (item.delivery.kind === 'registry') item.delivery.registryKind = kind
      const { hub, root } = fixture([item])
      await hub.install(item.id, item.version)
      expect(readFileSync(join(root, 'registry', kind, 'review.md'), 'utf8')).toContain('Read evidence')
      expect(registry.enabledFor(root, null)).toEqual([])
    }
  })
  it('does not commit a download with the wrong digest', async () => {
    const item = entry(); if (item.delivery.kind !== 'pi-package') delete item.delivery.bundled
    const { hub, root } = fixture([item], (async () => new Response('{"different":true}')) as typeof fetch)
    await expect(hub.install(item.id, item.version)).rejects.toThrow('differs')
    expect(existsSync(join(root, 'hub', 'installed.json'))).toBe(false)
    expect(hub.busy).toBe(false)
  })
  it('previews reviewed bytes without creating files or receipts', async () => {
    const item = entry(); if (item.delivery.kind !== 'pi-package') delete item.delivery.bundled
    const { hub, root } = fixture([item], (async () => new Response('{"message":"data only"}')) as typeof fetch)
    const preview = await hub.get(item.id, item.version, true)
    expect(preview.delivery.kind !== 'pi-package' && preview.delivery.bundled).toContain('data only')
    expect(existsSync(join(root, 'hub'))).toBe(false)
  })
  it('can reinstall deleted resources and clears stale attachment grants', async () => {
    const { hub, root } = fixture([entry('registry', skill())])
    await hub.install('example/review', '1.0.0')
    registry.setEnabled(root, null, ['skills/review'])
    rmSync(join(root, 'registry', 'skills', 'review'), { recursive: true })
    expect((await hub.list()).installed).toEqual([])
    await hub.install('example/review', '1.0.0')
    expect(registry.enabledFor(root, null)).toEqual([])
    expect((await hub.list()).installed).toHaveLength(1)
  })
  it('preserves corrupt installation records rather than overwriting them', async () => {
    const { hub, root } = fixture([entry()])
    mkdirSync(join(root, 'hub'), { recursive: true })
    writeFileSync(join(root, 'hub', 'installed.json'), 'corrupt')
    await expect(hub.install('example/review', '1.0.0')).rejects.toThrow('could not be read')
    expect(readFileSync(join(root, 'hub', 'installed.json'), 'utf8')).toBe('corrupt')
  })
  it('requires the terminal extension control key for hub mutations', async () => {
    const { hub, root } = fixture([entry()])
    const socket = new SessionSocket(join(root, 'unused.sock'), { memory: () => '', apps: async () => null,
      plugins: async (_grant, method, params, control) => {
        if (method === 'hub.list') return hub.list()
        if (!control) throw new HarnessError('unauthorized', 'Only the terminal controls installations.')
        return hub.install(String(params.id), String(params.version))
      } })
    const token = socket.issue({ sessionId: 'terminal', caller: () => ({}), broker: null })
    const install = { token, call: 'hub.install', params: { id: 'example/review', version: '1.0.0' } }
    expect(await socket.handle(JSON.stringify(install))).toHaveProperty('error')
    const claim = await socket.handle(JSON.stringify({ token, call: 'control.claim' })) as { result: { key: string } }
    expect(await socket.handle(JSON.stringify({ ...install, control: claim.result.key }))).toHaveProperty('result.document')
    await socket.close()
  })
  it('CLI installs into the explicit library without opening or settling runs', async () => {
    const { hub, harness, root } = fixture([entry()])
    const output: string[] = []
    const code = await runHubCli(['install', 'example/review@1.0.0', '--data', root, '--state', harness.stateDir], { write: (text) => output.push(text), createHarness: (options) => {
      expect(options.dataRoot).toBe(root)
      return { ...harness, hub, close: async () => undefined } as unknown as Harness
    } })
    expect(code).toBe(0)
    expect(output.join('')).toContain('Saved example/review@1.0.0')
    expect(existsSync(join(root, 'runs'))).toBe(false)
  })
  it('uses the last valid catalog when refresh fails or has duplicate versions', async () => {
    let response = JSON.stringify({ schemaVersion: 1, entries: [entry()] })
    const { hub } = fixture([], (async () => new Response(response)) as typeof fetch)
    expect((await hub.list(true)).origin).toBe('remote')
    response = JSON.stringify({ schemaVersion: 1, entries: [entry(), entry()] })
    const cached = await hub.list(true)
    expect(cached.origin).toBe('cached')
    expect(cached.error).toBeTruthy()
    expect(cached.entries).toHaveLength(1)
    expect((await hub.list()).entries).toHaveLength(1)
  })
  it('rejects simultaneous writers and releases locks after a failed download', async () => {
    const item = entry(); if (item.delivery.kind !== 'pi-package') delete item.delivery.bundled
    let resolve!: (response: Response) => void
    const { hub } = fixture([item], (() => new Promise<Response>((done) => { resolve = done })) as typeof fetch)
    const first = hub.install(item.id, item.version)
    await expect(hub.install(item.id, item.version)).rejects.toThrow('Another installation')
    resolve(new Response('bad digest'))
    await expect(first).rejects.toThrow('differs')
    expect(hub.busy).toBe(false)
  })
  it('keeps an in-progress installation pinned to its data root', async () => {
    const item = entry(); if (item.delivery.kind !== 'pi-package') delete item.delivery.bundled
    const root = mkdtempSync(join(tmpdir(), 'hub-root-pin-')); folders.push(root)
    let resolve!: (response: Response) => void
    const harness = new Harness({ dataRoot: join(root, 'data'), stateDir: join(root, 'state'), secrets: memorySecretStore(), hub: { catalog: { schemaVersion: 1, entries: [item] }, fetch: (() => new Promise<Response>((done) => { resolve = done })) as typeof fetch } })
    try {
      const pending = harness.hub.install(item.id, item.version)
      expect(() => harness.open(join(root, 'other'))).toThrow('Wait for the hub installation')
      expect(harness.dataRoot).toBe(join(root, 'data'))
      resolve(new Response('{"message":"data only"}'))
      await pending
      expect((await harness.hub.list()).installed).toHaveLength(1)
      expect(existsSync(join(root, 'other'))).toBe(false)
    } finally { await harness.close() }
  })
  it('rejects unpinned packages and incompatible runtimes', async () => {
    expect(() => hubEntrySchema.parse({ ...entry(), delivery: { kind: 'pi-package', source: 'npm:unknown@latest' } })).toThrow()
    expect(() => hubCatalogSchema.parse({ schemaVersion: 2, entries: [] })).toThrow()
    const item = { ...entry(), requires: { harness: '99.0.0' } }
    const { hub } = fixture([item])
    await expect(hub.install(item.id, item.version)).rejects.toThrow('requires Harness')
  })
  it('does not treat cancelling the terminal review as an install', async () => {
    const { hub } = fixture([entry()])
    const calls: string[] = []
    const choices = ['Review · preset · example/review@1.0.0', 'Done']
    await runHubMenu({ select: async () => choices.shift(), confirm: async () => false, notify: () => undefined }, async <T>(method: string) => { calls.push(method); return await hub.list() as T })
    expect(calls).toEqual(['hub.list', 'hub.list'])
  })
  it('refuses an already-held library lock', async () => {
    const { hub, root } = fixture([entry()])
    mkdirSync(join(root, 'hub'), { recursive: true })
    writeFileSync(join(root, 'hub', 'install.lock'), String(process.pid))
    await expect(hub.install('example/review', '1.0.0')).rejects.toThrow('Another installation')
    expect(hub.busy).toBe(false)
  })
})
