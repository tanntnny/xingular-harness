import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import type { ComponentItem } from '../../../variant/components'
import { createHarnessTheme } from '../theme'
import { ComponentsPage, type ComponentLibrarySnapshot } from './componentsPage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)
const items: ComponentItem[] = [
  { id: 'skills/review', kind: 'skills', name: 'Review', description: 'Review a change.', path: '/registry/skills/review/SKILL.md' },
  { id: 'prompts/outline', kind: 'prompts', name: 'Outline', description: 'Make an outline.', path: '/registry/prompts/outline.md' },
  { id: 'rules/testing', kind: 'rules', name: 'Testing', description: 'Always test.', path: '/registry/rules/testing.md' }
]

function setup(options: { writable?: boolean; addedIds?: string[] } = {}) {
  const calls: Array<[string, Record<string, unknown> | undefined]> = []
  const snapshot: ComponentLibrarySnapshot = { items, addedIds: options.addedIds ?? [], writable: options.writable ?? true, fingerprint: 'old-version' }
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    calls.push([method, params])
    if (method === 'terminal.components.list') return snapshot
    if (method === 'terminal.components.add') return { fingerprint: 'new-version', alreadyPresent: false }
    return undefined
  }) as unknown as ConstructorParameters<typeof ComponentsPage>[0]['call']
  const ui = { select: vi.fn(), confirm: vi.fn(async () => true), notify: vi.fn() }
  const notify = vi.fn()
  const page = new ComponentsPage({ theme: () => theme, call, ui, notify, changed: vi.fn() })
  page.focused = true
  return { page, call, calls, ui, notify }
}
const plain = (page: ComponentsPage) => page.render(80, 24).map(stripTerminalSequences).join('\n')
async function ready(options: Parameters<typeof setup>[0] = {}) {
  const result = setup(options)
  result.page.activate()
  await vi.waitFor(() => expect(plain(result.page)).toContain('1 item'))
  return result
}

describe('the Components page', () => {
  it('shows Skills, Prompts and Rules as local tabs and searches the selected section', async () => {
    const { page } = await ready()
    expect(page.tabs().map(tab => tab.title)).toEqual(['Skills', 'Prompts', 'Rules'])
    expect(plain(page)).toContain('Review')
    expect(plain(page)).not.toContain('Outline')
    page.handleInput('review')
    expect(plain(page)).toContain('1 of 1')
    expect(page.handleInput('\x1b')).toBe(true)
    expect(plain(page)).toContain('Review')
  })

  it('asks before adding a skill and records it for the next session', async () => {
    const { page, calls, ui, notify } = await ready()
    page.handleInput('\r')
    await vi.waitFor(() => expect(ui.confirm).toHaveBeenCalledWith('Add Review?', expect.stringContaining('running terminal keeps its pinned version')))
    await vi.waitFor(() => expect(calls).toContainEqual(['terminal.components.add', { id: 'skills/review' }]))
    expect(notify).toHaveBeenCalledWith('Saved for the next session · version new-version', 'info')
  })

  it('keeps prompts browse-only and refuses to add them to a variant', async () => {
    const { page, calls, notify } = await ready()
    page.handleInput('\t')
    page.handleInput('\r')
    expect(calls.some(([method]) => method === 'terminal.components.add')).toBe(false)
    expect(notify).toHaveBeenCalledWith('Prompts stay in the library and cannot be added to a Variant.', 'info')
  })

  it('keeps the library browse-only when no writable scope is attached', async () => {
    const { page, calls, notify } = await ready({ writable: false })
    page.handleInput('\r')
    expect(calls.some(([method]) => method === 'terminal.components.add')).toBe(false)
    expect(notify).toHaveBeenCalledWith('This terminal has no writable Harness scope. The library is browse-only.', 'warning')
  })

  it('marks existing items and does not ask to add them twice', async () => {
    const { page, ui, calls, notify } = await ready({ addedIds: ['skills/review'] })
    expect(plain(page)).toContain('In Harness')
    page.handleInput('\r')
    expect(ui.confirm).not.toHaveBeenCalled()
    expect(calls.some(([method]) => method === 'terminal.components.add')).toBe(false)
    expect(notify).toHaveBeenCalledWith('This item is already in the current Variant.', 'info')
  })
})
