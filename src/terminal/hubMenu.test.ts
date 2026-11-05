import { describe, expect, it, vi } from 'vitest'
import type { HubEntry } from '../hub/schema'
import { hubSummary, installHubEntry, marketplaceType } from './hubMenu'
import type { MenuCall } from './pluginMenu'

const base: Omit<HubEntry, 'delivery'> = {
  id: 'example/item', title: 'Example', description: 'An example', publisher: 'Example', license: 'MIT',
  version: '1.0.0', category: 'skill', channel: 'community', tags: [], requires: {}, sourceUrl: 'https://example.com/source'
}
const payload = { url: 'https://example.com/data', sha256: 'a'.repeat(64) }
const entries: Array<[HubEntry, string, string]> = [
  [{ ...base, delivery: { kind: 'pi-package', source: 'npm:example@1.0.0' } }, 'Plugins', '/plugins'],
  [{ ...base, delivery: { kind: 'registry', registryKind: 'skills', ...payload } }, 'Skills', '/skills'],
  [{ ...base, delivery: { kind: 'registry', registryKind: 'rules', ...payload } }, 'Rules', '/components'],
  [{ ...base, delivery: { kind: 'registry', registryKind: 'prompts', ...payload } }, 'Prompts', 'cannot be added'],
  [{ ...base, category: 'connector', delivery: { kind: 'document', ...payload } }, 'MCP definitions', '/mcp'],
  [{ ...base, category: 'other', delivery: { kind: 'document', ...payload } }, 'Documents', 'compatible application']
]

describe('Marketplace installation guidance', () => {
  it.each(entries)('describes and guides %s by delivery type', async (entry, label, guidance) => {
    const ui = { select: vi.fn(), confirm: vi.fn(async () => true), notify: vi.fn() }
    const call = vi.fn(async () => ({}))
    await installHubEntry(ui, call as MenuCall, entry)
    expect(marketplaceType(entry)).toBe(label)
    expect(call).toHaveBeenCalledWith('hub.install', { id: entry.id, version: entry.version })
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining(guidance), 'info')
    if (entry.delivery.kind === 'document') expect(hubSummary(entry)).toContain('No connection is created or enabled')
  })

  it('does not install or report success when confirmation is declined', async () => {
    const ui = { select: vi.fn(), confirm: vi.fn(async () => false), notify: vi.fn() }
    const call = vi.fn(async () => ({}))
    await installHubEntry(ui, call as MenuCall, entries[0]![0])
    expect(call).not.toHaveBeenCalled()
    expect(ui.notify).not.toHaveBeenCalled()
  })
})
