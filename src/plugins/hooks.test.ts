import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { Bus } from '../core/bus'
import { createHarness, type Harness } from '../harness'
import { methods } from '../server/methods'
import { rootWithProject, writeFile } from '../../tests/helpers'
import { entryEvent, Hooks, type HookEvent } from './hooks'
import type { Plugin } from './types'

const open: Harness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})

const temp = (): string => mkdtempSync(join(tmpdir(), 'hooks-'))
// The test runner owns `import()` here; in a real process the harness uses Node's own.
const importFile = (address: string): Promise<unknown> => import(/* @vite-ignore */ address)

/** A hooks file that appends what it was told to a file, so a test can read it back. */
const recorder = (out: string, events: string[], extra = ''): string =>
  `import { appendFileSync } from 'node:fs'\nexport default function (harness) {\n${events.map((event) => `  harness.on('${event}', async (event, ctx) => { appendFileSync(${JSON.stringify(out)}, JSON.stringify({ type: event.type, id: event.id ?? event.runId, title: event.title, body: event.body, actor: event.actor }) + '\\n')${extra} })`).join('\n')}\n}\n`

const told = (out: string): Record<string, unknown>[] => (existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])

function kit(folder: string, name: string, hooks: string): void {
  writeFile(join(folder, 'package.json'), JSON.stringify({ name, version: '1.0.0', description: `${name} mirrors notes.`, harness: { extends: ['wiki', 'nonsense'], hooks: './hooks.mjs' } }))
  writeFile(join(folder, 'hooks.mjs'), hooks)
}

function setup() {
  const root = rootWithProject()
  const base = temp()
  const harness = createHarness({ dataRoot: root, stateDir: join(base, 'state'), secrets: memorySecretStore(), hookImporter: importFile })
  open.push(harness)
  const table = methods(harness)
  const call = <T>(method: string, params: Record<string, unknown> = {}) => table[method](params) as Promise<T>
  const saveFact = (title: string, body: string) => call('wiki.write', { path: `library/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, text: `---\ntitle: ${title}\n---\n\n${body}\n` })
  return { harness, root, base, call, saveFact }
}

describe('a written file as an event', () => {
  it('is a saved note, titled from its front matter', () => {
    const wiki = '/data/wiki'
    const change = (path: string, text: string) => entryEvent({ wiki, id: 'x', path: join(wiki, path), text, actor: 'user', reason: 'Edited' })
    expect(change('library/arch.md', '---\ntitle: Architecture\n---\n\nLayers.\n')).toMatchObject({ type: 'wiki.page.saved', title: 'Architecture', body: 'Layers.', actor: 'user' })
    expect(change('home.md', 'No front matter.')).toMatchObject({ type: 'wiki.page.saved', title: 'x', body: 'No front matter.' })
  })
})

describe('hooks a plugin gives the harness', () => {
  it('mirrors saved notes through a real disposable MCP subprocess and stops on detach, changed code or revoked permission', async () => {
    const { harness, base, call, saveFact } = setup()
    const output = join(base, 'mirrored.jsonl')
    await harness.apps.save({ id: 'mirror', name: 'Disposable mirror', kind: 'local', command: process.execPath, args: [join(process.cwd(), 'tests/mcp-hook-fixture.mjs'), output], enabled: true, global: true, readTools: ['mirror_fact'] })
    const paths = ['one', 'two'].map((name) => join(base, name))
    for (const [index, path] of paths.entries()) {
      const name = ['mirror-one', 'mirror-two'][index]
      kit(path, name, `export default function(harness) { harness.on('wiki.page.saved', async (event, ctx) => { await ctx.call('Disposable mirror', 'mirror_fact', { plugin: '${name}', id: event.id, title: event.title, body: event.body }) }) }\n`)
      const plugins = await call<Plugin[]>('plugins.install', { source: path })
      const plugin = plugins.find((entry) => entry.id === `package:${name}`)!
      await call('plugins.attach', { id: plugin.id })
      await call('plugins.trust', { hash: plugin.code!.hash })
    }
    await harness.hooks.reload()
    await saveFact('Synthetic one', 'Generated probe body.')
    await harness.hooks.settled()
    expect(told(output).map((row) => row.plugin)).toEqual(['mirror-one', 'mirror-two'])
    expect(told(output)[0]).toMatchObject({ title: 'Synthetic one', body: 'Generated probe body.' })
    await call('plugins.detach', { id: 'package:mirror-one' })
    await saveFact('Synthetic two', 'Second body.')
    await harness.hooks.settled()
    expect(told(output).map((row) => row.plugin)).toEqual(['mirror-one', 'mirror-two', 'mirror-two'])
    writeFile(join(paths[1], 'hooks.mjs'), '// Changed since trust\nexport default function() {}\n')
    await saveFact('Synthetic three', 'Untrusted code hears nothing.')
    await harness.hooks.settled()
    expect(told(output)).toHaveLength(3)
    await call('plugins.attach', { id: 'package:mirror-one' })
    await harness.apps.save({ id: 'mirror', name: 'Disposable mirror', kind: 'local', command: process.execPath, args: [join(process.cwd(), 'tests/mcp-hook-fixture.mjs'), output], enabled: true, global: true, readTools: [] })
    await harness.hooks.reload()
    await saveFact('Synthetic four', 'Write succeeds with permission revoked.')
    await harness.hooks.settled()
    expect(told(output)).toHaveLength(3)
    expect(harness.hooks.status()[join(paths[0], 'hooks.mjs')].lastError).toContain('asks before running')
  })

  it('run for every plugin that listens, only once the plugin is switched on for everyone and trusted', async () => {
    const { harness, base, call, saveFact } = setup()
    const one = join(base, 'one.log')
    const two = join(base, 'two.log')
    kit(join(base, 'docs'), 'notes-to-docs', recorder(one, ['wiki.page.saved']))
    kit(join(base, 'sheet'), 'notes-to-sheet', recorder(two, ['wiki.page.saved', 'history.run.ended']))
    await call('plugins.install', { source: join(base, 'docs') })
    const listed = await call<Plugin[]>('plugins.install', { source: join(base, 'sheet') })
    const docs = listed.find((plugin) => plugin.id === 'package:notes-to-docs')!
    const sheet = listed.find((plugin) => plugin.id === 'package:notes-to-sheet')!
    // What it says it extends is kept only for parts that exist.
    expect(docs).toMatchObject({ extends: ['wiki'], runsCode: true, trust: 'untrusted', attachment: { global: false } })
    expect(docs.contributions.map((entry) => [entry.kind, entry.name, entry.state])).toEqual([['code', 'hooks.mjs', 'off']])

    // Installed, switched off, untrusted: a saved note reaches nobody.
    await saveFact('Use pnpm', 'Always pnpm.')
    await harness.hooks.settled()
    expect([told(one), told(two)]).toEqual([[], []])

    // Switched on but not trusted is still nothing.
    await call('plugins.attach', { id: docs.id })
    await call('plugins.attach', { id: sheet.id })
    await harness.hooks.reload()
    await saveFact('Tabs', 'Use tabs.')
    await harness.hooks.settled()
    expect([told(one), told(two)]).toEqual([[], []])

    // Trusted: both hear the next note, each in its own way.
    await call('plugins.trust', { hash: docs.code!.hash })
    const trusted = await call<Plugin[]>('plugins.trust', { hash: sheet.code!.hash })
    await harness.hooks.reload()
    await saveFact('Line length', 'Wrap at 100.')
    await harness.hooks.settled()
    expect(told(one)).toEqual([{ type: 'wiki.page.saved', id: expect.any(String), title: 'Line length', body: 'Wrap at 100.', actor: 'user' }])
    expect(told(two)).toEqual(told(one))
    expect(trusted.find((plugin) => plugin.id === docs.id)!.contributions[0]).toMatchObject({ state: 'on', problem: null })
    const described = (await call<Plugin[]>('plugins.list')).find((plugin) => plugin.id === sheet.id)!.contributions[0]
    expect(described.description).toBe('Runs in the background after: wiki.page.saved, history.run.ended.')

    // Switched off for everyone again, it stops hearing; the other keeps going.
    await call('plugins.detach', { id: docs.id })
    await harness.hooks.reload()
    await saveFact('Indent', 'Two spaces.')
    await harness.hooks.settled()
    expect([told(one).length, told(two).length]).toEqual([1, 2])
  })

  it('never lets a hook that throws or hangs touch the write, and shows what went wrong on its plugin', async () => {
    const bus = new Bus()
    const base = temp()
    const out = join(base, 'ok.log')
    writeFile(join(base, 'bad.mjs'), `export default function (harness) { harness.on('wiki.page.saved', async () => { throw new Error('the document is gone') }) }\n`)
    writeFile(join(base, 'slow.mjs'), `export default function (harness) { harness.on('wiki.page.saved', () => new Promise(() => {})) }\n`)
    writeFile(join(base, 'good.mjs'), recorder(out, ['wiki.page.saved']))
    writeFile(join(base, 'broken.mjs'), `export const nothing = 1\n`)
    writeFile(join(base, 'unknown.mjs'), `export default function (harness) { harness.on('memory.deleted', () => {}) }\n`)
    const hooks = new Hooks({ stateDir: base, bus, timeoutMs: 40, importFile, call: async () => undefined, wanted: async () => ['bad', 'slow', 'good', 'broken', 'unknown'].map((name) => ({ path: join(base, `${name}.mjs`), hash: 'h1' })) })
    await hooks.reload()
    const event: HookEvent = { type: 'wiki.page.saved', id: 'f1', path: '/w/library/f1.md', title: 'Fact', body: 'Body', text: 'Body', actor: 'user', reason: 'Created', at: '2026-10-13T00:00:00.000Z' }
    hooks.emit(event)
    await hooks.settled()
    // The good hook ran although two before it failed.
    expect(told(out)).toHaveLength(1)
    const status = hooks.status()
    expect(status[join(base, 'bad.mjs')]).toMatchObject({ events: ['wiki.page.saved'], lastError: 'wiki.page.saved: the document is gone' })
    expect(status[join(base, 'slow.mjs')].lastError).toMatch(/took longer than/)
    expect(status[join(base, 'good.mjs')]).toMatchObject({ lastError: null, lastRunAt: expect.any(String) })
    expect(status[join(base, 'broken.mjs')].lastError).toBe('It could not be loaded: It must export a default function.')
    expect(status[join(base, 'unknown.mjs')].lastError).toMatch(/There is no event called "memory.deleted"/)
    hooks.close()
  })

  it('reads a hooks file again when its code changed, and keeps the one it has when it did not', async () => {
    const base = temp()
    const path = join(base, 'hooks.mjs')
    let hash = 'h1'
    const read: string[] = []
    const heard: string[] = []
    // Stands in for the file on disk: each read gives the code as it is at that moment.
    const importer = async (address: string) => {
      read.push(address.slice(address.indexOf('?')))
      const version = read.length
      return { default: (harness: { on(event: string, handler: () => void): void }) => harness.on('wiki.page.saved', () => void heard.push(`version ${version}`)) }
    }
    const hooks = new Hooks({ stateDir: base, bus: new Bus(), call: async () => undefined, importFile: importer, wanted: async () => [{ path, hash }] })
    const event: HookEvent = { type: 'wiki.page.saved', id: 'p1', path: '/w/library/p1.md', title: 'Page', body: 'One', text: 'One', actor: 'user', reason: 'Edited', at: '2026-10-13T00:00:00.000Z' }
    await hooks.reload()
    await hooks.reload()
    hooks.emit(event)
    await hooks.settled()
    hash = 'h2'
    await hooks.reload()
    hooks.emit(event)
    await hooks.settled()
    // The fingerprint is part of the address, so Node does not hand back the module it already has.
    expect(read).toEqual(['?v=h1', '?v=h2'])
    expect(heard).toEqual(['version 1', 'version 2'])
    hooks.close()
  })

  it('lets a hook reach a connected app only through a tool marked to run without asking', async () => {
    const { harness } = setup()
    await harness.apps.save({ id: 'docs', name: 'Docs', kind: 'local', command: process.execPath, args: [join(process.cwd(), 'tests/mcp-fixture.mjs')], enabled: true, global: true, readTools: ['read_record'] })
    await harness.apps.save({ id: 'private', name: 'Private', kind: 'local', command: process.execPath, args: [join(process.cwd(), 'tests/mcp-fixture.mjs')], enabled: true, global: false, agentIds: ['a1'], readTools: ['read_record'] })
    expect(await harness.apps.callUnattended('Docs', 'read_record', {})).toMatchObject({ content: [{ type: 'text', text: 'fixture' }] })
    await expect(harness.apps.callUnattended('Docs', 'change_record', {})).rejects.toThrow('asks before running "change_record"')
    // A hook runs for everyone, so an app that is on for one agent only is out of its reach.
    await expect(harness.apps.callUnattended('Private', 'read_record', {})).rejects.toThrow('on for everyone')
    await expect(harness.apps.callUnattended('Nope', 'read_record', {})).rejects.toThrow('no connected app called "Nope"')
  })
})
