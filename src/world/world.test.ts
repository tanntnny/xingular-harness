import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import type { ToolSession } from '../tools/types'
import { classifyAction, SENSITIVE_FIELD } from './actions'
import { firstKept, pruneToolImages } from './images'
import { isWorldTool, untrusted, UNTRUSTED_NOTICE } from './untrusted'
import { World } from './world'

const shot = (n: number) => ({ role: 'toolResult', content: [{ type: 'text', text: `step ${n}` }, { type: 'image', data: `img${n}`, mimeType: 'image/jpeg' }] })

describe('screenshot pruning', () => {
  it('keeps every image until there are more than six', () => {
    const messages = [1, 2, 3, 4, 5, 6].map(shot)
    expect(pruneToolImages(messages)).toBe(messages)
  })

  it('then keeps only the latest, moving the cut in steps of four so earlier messages rarely change', () => {
    expect([7, 8, 9, 10, 11, 12, 13, 14].map(firstKept)).toEqual([4, 4, 4, 4, 8, 8, 8, 8])
    const pruned = pruneToolImages([1, 2, 3, 4, 5, 6, 7].map(shot))
    const images = pruned.flatMap((message) => (message.content as { type: string; text?: string }[]))
    expect(images.filter((block) => block.type === 'image')).toHaveLength(3)
    expect(images.find((block) => block.text?.startsWith('[screenshot 1 omitted'))).toBeTruthy()
  })

  it('leaves images a person attached alone', () => {
    const user = { role: 'user', content: [{ type: 'image', data: 'mine', mimeType: 'image/png' }] }
    const pruned = pruneToolImages([user, ...[1, 2, 3, 4, 5, 6, 7].map(shot)])
    expect(pruned[0]).toBe(user)
  })
})

describe('world tools', () => {
  it('marks every result as untrusted and knows its tools by name', () => {
    expect(untrusted('page').startsWith(UNTRUSTED_NOTICE)).toBe(true)
    expect(['web_fetch', 'browser_click', 'computer_type'].every(isWorldTool)).toBe(true)
    expect(isWorldTool('wiki_read')).toBe(false)
  })

  it('names the actions a person must approve, and fields a tool never fills', () => {
    expect(classifyAction('button "Place order"')?.category).toBe('purchase')
    expect(classifyAction('button "Send"')?.category).toBe('send')
    expect(classifyAction('link "Docs"')).toBeNull()
    expect(SENSITIVE_FIELD.test('textbox "Password"')).toBe(true)
    expect(SENSITIVE_FIELD.test('textbox "Search"')).toBe(false)
  })

  it('offers a tool only when its plugin is on for the caller', async () => {
    const root = mkdtempSync(join(tmpdir(), 'world-'))
    const world = new World({ root: () => root, stateDir: root, secrets: memorySecretStore() })
    const session = (contributions: string[]) => ({ run: { runId: 'r', sessionId: 's' }, caller: {}, allow: [], depth: 0, cwd: root, capabilities: { version: 1, tools: [], connectors: [], contributions } }) as unknown as ToolSession
    expect((await world.provider()(session(['web/tool/web_fetch']))).map((tool) => tool.name)).toEqual(['web_fetch'])
    expect((await world.provider()(session(['wiki/tool/wiki_read']))).map((tool) => tool.name)).toEqual([])
    // A host with no capability catalogue gets them all.
    expect((await world.provider()(session([]))).map((tool) => tool.name).slice(0, 3)).toEqual(['web_search', 'web_fetch', 'browser_navigate'])
  })
  it('lets an embedding host disable the generic browser without disabling web tools or page notes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'world-host-browser-'))
    const world = new World({ root: () => root, stateDir: root, secrets: memorySecretStore(), browser: false })
    expect(world.plugins.map(plugin => plugin.id)).toEqual(['web', 'annotations'])
    await world.close()
  })

})
