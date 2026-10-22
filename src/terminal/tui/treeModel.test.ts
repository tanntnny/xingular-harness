import type { SessionEntry, SessionTreeNode } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'

import { TreeModel, formatToolCall } from './treeModel'

const at = '2026-10-18T00:00:00.000Z'
const message = (id: string, parentId: string | null, role: string, text: string, extra: Record<string, unknown> = {}): SessionEntry => ({
  type: 'message', id, parentId, timestamp: at, message: { role, content: text ? [{ type: 'text', text }] : [], ...extra }
}) as unknown as SessionEntry
const node = (entry: SessionEntry, children: SessionTreeNode[] = [], label?: string): SessionTreeNode => ({ entry, children, ...(label ? { label } : {}) })

/**
 * u1 ─ a1 ─┬─ u2 ─ a2                       (branch A)
 *          └─ u3 ─ call ─ result ─ a3       (branch B, where the session stands)
 */
function tree(): SessionTreeNode[] {
  const call = message('call', 'u3', 'assistant', '', { content: [{ type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: 'README.md' } }], stopReason: 'toolUse' })
  const result = message('result', 'call', 'toolResult', 'file body', { toolCallId: 'tc1', toolName: 'read' })
  return [node(message('u1', null, 'user', 'start here'), [
    node(message('a1', 'u1', 'assistant', 'hello there'), [
      node(message('u2', 'a1', 'user', 'branch A question'), [node(message('a2', 'u2', 'assistant', 'answer A'))]),
      node(message('u3', 'a1', 'user', 'branch B question'), [node(call, [node(result, [node(message('a3', 'result', 'assistant', 'answer B'))])])])
    ])
  ])]
}
const ids = (model: TreeModel) => model.rows.map(row => row.node.entry.id)

describe('the session tree model', () => {
  it('lists the branch the session stands on first, hides assistant turns that only called tools, and starts on the current entry', () => {
    const model = new TreeModel(tree(), 'a3')
    expect(ids(model)).toEqual(['u1', 'a1', 'u3', 'result', 'a3', 'u2', 'a2'])
    expect(model.selectedNode?.entry.id).toBe('a3')
    expect(model.isOnActivePath('u3')).toBe(true)
    expect(model.isOnActivePath('u2')).toBe(false)
  })

  it('draws connectors for a branch point: each child hangs from it, the last one closes it', () => {
    const model = new TreeModel(tree(), 'a3')
    const u3 = model.rows.find(row => row.node.entry.id === 'u3')!
    const u2 = model.rows.find(row => row.node.entry.id === 'u2')!
    expect([u3.showConnector, u3.isLast]).toEqual([true, false])
    expect([u2.showConnector, u2.isLast]).toEqual([true, true])
    expect(u3.indent).toBe(1)
    expect(model.rows.find(row => row.node.entry.id === 'u1')!.showConnector).toBe(false)
  })

  it('shows the current entry even when it only called tools, so the position is always visible', () => {
    const model = new TreeModel(tree(), 'call')
    expect(ids(model)).toContain('call')
    expect(model.selectedNode?.entry.id).toBe('call')
  })

  it('filters by kind and goes back to the default when the same filter is chosen again', () => {
    const model = new TreeModel(tree(), 'a3')
    model.toggleFilter('user-only')
    expect(ids(model)).toEqual(['u1', 'u3', 'u2'])
    model.toggleFilter('user-only')
    expect(model.filterMode).toBe('default')
    model.setFilter('no-tools')
    expect(ids(model)).not.toContain('result')
    model.setFilter('labeled-only')
    expect(ids(model)).toEqual([])
    model.setLabel('u2', 'keep this')
    expect(ids(model)).toEqual(['u2'])
    model.setFilter('all')
    expect(ids(model)).toContain('result')
  })

  it('cycles the filters forwards and backwards through the five modes', () => {
    const model = new TreeModel(tree(), 'a3')
    const seen: string[] = []
    for (let i = 0; i < 5; i++) { model.cycleFilter(1); seen.push(model.filterMode) }
    expect(seen).toEqual(['no-tools', 'user-only', 'labeled-only', 'all', 'default'])
    model.cycleFilter(-1)
    expect(model.filterMode).toBe('all')
  })

  it('searches the text of every entry with all words required, and keeps the nearest visible entry selected', () => {
    const model = new TreeModel(tree(), 'a3')
    model.setSearch('branch b')
    expect(ids(model)).toEqual(['u3'])
    expect(model.selectedNode?.entry.id).toBe('u3')
    model.setSearch('answer')
    expect(ids(model)).toEqual(['a3', 'a2'])
    model.setSearch('nothing matches this')
    expect(model.rows).toHaveLength(0)
    model.setSearch('')
    expect(ids(model)).toHaveLength(7)
  })

  it('folds a branch segment, hides everything under it, and unfolds it again', () => {
    const model = new TreeModel(tree(), 'a3', 'u1')
    expect(model.isFoldable('u1')).toBe(true)
    expect(model.isFoldable('a1')).toBe(false)
    model.foldOrUp()
    expect(model.isFolded('u1')).toBe(true)
    expect(ids(model)).toEqual(['u1'])
    model.unfoldOrDown()
    expect(model.isFolded('u1')).toBe(false)
    expect(ids(model)).toHaveLength(7)
  })

  it('jumps between branch segments when there is nothing to fold or unfold', () => {
    const model = new TreeModel(tree(), 'a3')
    model.foldOrUp()
    expect(model.selectedNode?.entry.id).toBe('u3')
    model.unfoldOrDown()
    expect(model.selectedNode?.entry.id).toBe('a3')
  })

  it('moves one row at a time, stays inside the list, and wraps only when asked', () => {
    const model = new TreeModel(tree(), 'a3', 'u1')
    model.move(-1)
    expect(model.selectedIndex).toBe(0)
    model.move(100)
    expect(model.selectedIndex).toBe(model.rows.length - 1)
    model.move(1, true)
    expect(model.selectedIndex).toBe(0)
  })

  it('records a label with the time it was set, and clears it', () => {
    const model = new TreeModel(tree(), 'a3')
    model.setLabel('u2', 'idea')
    const labelled = model.rows.find(row => row.node.entry.id === 'u2')!.node
    expect(labelled.label).toBe('idea')
    expect(Date.parse(labelled.labelTimestamp!)).not.toBeNaN()
    model.setLabel('u2', undefined)
    expect(labelled.label).toBeUndefined()
    expect(labelled.labelTimestamp).toBeUndefined()
  })

  it('copies the full text of the selected entry, and nothing for one without text', () => {
    const model = new TreeModel(tree(), 'a3', 'u3')
    expect(model.copyText()).toBe('branch B question')
    expect(model.copyText(model.rows.find(row => row.node.entry.id === 'a3')!.node)).toBe('answer B')
    const withError = new TreeModel([node(message('e', null, 'assistant', '', { errorMessage: 'rate limited', stopReason: 'error' }))], 'e')
    expect(withError.copyText()).toBe('rate limited')
    expect(new TreeModel([node({ type: 'model_change', id: 'm', parentId: null, timestamp: at, provider: 'p', modelId: 'x' } as SessionEntry)], null).copyText()).toBeUndefined()
  })

  it('describes entries the way a row reads', () => {
    const model = new TreeModel(tree(), 'a3', 'u1')
    const text = (id: string) => model.describe(model.rows.find(row => row.node.entry.id === id)!.node)
    expect(text('u1')).toMatchObject({ lead: 'user: ', text: 'start here' })
    expect(text('a3')).toMatchObject({ lead: 'assistant: ', text: 'answer B' })
    expect(text('result')).toMatchObject({ text: '[read: README.md]', textTone: 'muted' })
    const odd = new TreeModel([node(message('x', null, 'assistant', '', { stopReason: 'aborted' }))], 'x')
    expect(odd.describe(odd.rows[0]!.node)).toMatchObject({ text: '(aborted)' })
  })

  it('reads as one tree under several roots, and never shows usage records', () => {
    const roots = [node(message('r1', null, 'user', 'first root')), node(message('r2', null, 'user', 'second root'), [node({ type: 'usage', id: 'usage', parentId: 'r2', timestamp: at } as unknown as SessionEntry)])]
    const model = new TreeModel(roots, 'r2')
    expect(ids(model)).toEqual(['r2', 'r1'])
    expect(model.roots).toBe(true)
  })
})

describe('formatting a tool call', () => {
  it('shortens each tool to one bracketed phrase', () => {
    expect(formatToolCall('read', { path: 'a.ts', offset: 10, limit: 5 })).toBe('[read: a.ts:10-14]')
    expect(formatToolCall('bash', { command: 'ls\n-la' })).toBe('[bash: ls -la]')
    expect(formatToolCall('bash', { command: 'x'.repeat(60) })).toBe(`[bash: ${'x'.repeat(50)}...]`)
    expect(formatToolCall('grep', { pattern: 'foo' })).toBe('[grep: /foo/ in .]')
    expect(formatToolCall('mystery', { a: 1 })).toBe('[mystery: {"a":1}]')
  })
})
