import { describe, expect, it } from 'vitest'
import { browserItems, catalogSection, type BrowserRuntime, type BrowserSnapshot } from './browser'

const runtime: BrowserRuntime = { skills: [{ name: 'review', description: 'Loaded skill', filePath: '/p/review/SKILL.md' }],
  tools: [{ name: 'web_fetch', description: 'Read a public page', parameters: { type: 'object' } }], activeTools: ['web_fetch'], skillCommands: false }
const snapshot: BrowserSnapshot = { items: [
  { id: 'loaded', section: 'skills', name: 'Review', description: '', owner: 'Project', origin: 'project', status: 'Disabled', path: '/p/review/SKILL.md' },
  { id: 'library', section: 'skills', name: 'Review', description: '', owner: 'Library', origin: 'local', status: 'Library only', path: '/library/review/SKILL.md' },
  { id: 'tool', section: 'tools', name: 'web_fetch', description: '', owner: 'Web', origin: 'builtin', status: 'Enabled for future sessions' }
], plugins: [], connections: [], variant: { scope: null, pinned: null, latest: null, writable: false }, hub: null }

describe('terminal browser read model', () => {
  it('uses actual loaded paths rather than names or saved switches, even when skill commands are off', () => {
    const items = browserItems(snapshot, runtime)
    expect(items.find(item => item.id === 'loaded')).toMatchObject({ available: true, status: 'Available now', skillName: 'review' })
    expect(items.find(item => item.id === 'library')).not.toHaveProperty('available', true)
    expect(snapshot.items[0]?.status).toBe('Disabled')
    expect(items.find(item => item.id === 'tool')).toMatchObject({ available: true, owner: 'Web', parameters: { type: 'object' } })
  })

  it('reports unattributed runtime resources and inactive tools honestly', () => {
    const items = browserItems({ ...snapshot, items: [] }, { ...runtime, activeTools: [] })
    expect(items.find(item => item.section === 'tools')).toMatchObject({ owner: 'Runtime (unattributed)', status: 'Not active here' })
    expect(items.find(item => item.section === 'skills')).toMatchObject({ available: true })
  })

  it('does not guess an owner when several plugins declare the same tool name', () => {
    const tool = snapshot.items.find(item => item.id === 'tool')!
    const items = browserItems({ ...snapshot, items: [tool, { ...tool, id: 'other', owner: 'Disabled package', origin: 'package' }] }, runtime)
    expect(items.filter(item => item.available)).toEqual(expect.arrayContaining([expect.objectContaining({ owner: 'Runtime (unattributed)' }), expect.objectContaining({ section: 'skills' })]))
    expect(items.filter(item => item.available)).toHaveLength(2)
    const builtin = browserItems({ ...snapshot, items: [tool, { ...tool, id: 'other', owner: 'Disabled package', origin: 'package' }] }, {
      ...runtime, tools: runtime.tools.map(tool => ({ ...tool, sourceInfo: { path: 'builtin:web', source: 'builtin' } }))
    })
    expect(builtin.find(item => item.id === 'tool')).toMatchObject({ available: true, owner: 'Web' })
    expect(builtin.find(item => item.id === 'other')).not.toHaveProperty('available', true)
  })

  it('routes catalog entries by supported delivery and connector category', () => {
    expect(catalogSection({ delivery: { kind: 'registry', registryKind: 'skills' } } as never)).toBe('skills')
    expect(catalogSection({ delivery: { kind: 'document' }, category: 'connector' } as never)).toBe('connections')
    expect(catalogSection({ delivery: { kind: 'document' }, category: 'agent-template' } as never)).toBe('library')
  })
})
