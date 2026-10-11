import { expect, test } from 'vitest'

import { rootWithProject } from '../../tests/helpers'
import { applyEdit, attached, DEFAULT_LIMIT, edit, PROJECT_LIMIT, render, saveAsUser, undoLast, type BlockInput, type Caller } from './blocks'
import { readManifest, wikiDir } from './store'

const agent = (id: string): Caller => ({ kind: 'agent', id, name: 'Nora' })
const append = (text: string) => ({ kind: 'append' as const, text })

test('edits apply with limits and exact replacement', () => {
  expect(applyEdit('', append('Likes pnpm.'))).toBe('Likes pnpm.')
  expect(applyEdit('A', append(' B '))).toBe('A\nB')
  expect(applyEdit('Use npm.', { kind: 'replace', old: 'npm', new: 'pnpm' })).toBe('Use pnpm.')
  expect(() => applyEdit('a a', { kind: 'replace', old: 'a', new: 'b' })).toThrow('2 times')
  expect(() => applyEdit('a', { kind: 'replace', old: 'z', new: 'b' })).toThrow()
  expect(() => applyEdit('a', append('  '))).toThrow()
  expect(applyEdit('old', { kind: 'rethink', text: ' new ' })).toBe('new')
})

test('an agent gets its blocks, the user block and work project briefs', () => {
  const root = rootWithProject()
  const blocks = attached(root, agent('a1'), ['app', 'missing'])
  expect(blocks.map((block) => block.front.label)).toEqual(['persona', 'notes', 'user', 'project/app'])
  expect(blocks[0].id).toBe('blocks/agents/a1/persona')
  expect(blocks[3].front.limit).toBe(PROJECT_LIMIT)
  expect(attached(root, { kind: 'session', projectSlug: 'app' }, []).map((block) => block.front.label)).toEqual(['user', 'project/app'])
})

test('edits are revisioned, limited and undoable', () => {
  const root = rootWithProject()
  const wiki = wikiDir(root)
  const nora = agent('a1')
  expect(edit(root, nora, 'user', append('Prefers short answers.')).body).toBe('Prefers short answers.')
  const revisions = readManifest(wiki, 'blocks/shared/user')
  expect(revisions).toHaveLength(2)
  expect(revisions[1].actor).toBe('Nora')
  edit(root, nora, 'user', append('Works in Bangkok time.'))
  expect(readManifest(wiki, 'blocks/shared/user')).toHaveLength(3)
  expect(undoLast(wiki, 'blocks/shared/user').body).toBe('Prefers short answers.')
  expect(undoLast(wiki, 'blocks/shared/user').body).toBe('')
  expect(() => undoLast(wiki, 'blocks/shared/user')).toThrow()

  expect(() => edit(root, nora, 'notes', { kind: 'rethink', text: 'x'.repeat(DEFAULT_LIMIT + 1) })).toThrow('memory_rethink')
  expect(() => edit(root, nora, 'notes', append('key sk-ant-abc'))).toThrow('credential')
  expect(() => edit(root, nora, 'nope', append('x'))).toThrow()
})

test('sessions edit only their project brief', () => {
  const root = rootWithProject()
  const session: Caller = { kind: 'session', projectSlug: 'app' }
  expect(edit(root, session, 'project', append('Tauri 2 app.')).id).toBe('blocks/projects/app/brief')
  expect(() => edit(root, session, 'user', append('x'))).toThrow('cannot edit')
  expect(() => edit(root, session, 'persona', append('x'))).toThrow()
  attached(root, agent('a1'), [])
  expect(() => edit(root, session, 'blocks/agents/a1/persona', append('x'))).toThrow()
  expect(() => edit(root, { kind: 'session', projectSlug: null }, 'project/app', append('x'))).toThrow()
  // An agent may edit any project's brief, and its own blocks, but not another agent's.
  expect(edit(root, agent('a1'), 'project/app', append('Uses pnpm.')).body).toContain('Uses pnpm.')
  expect(() => edit(root, agent('a2'), 'blocks/agents/a1/persona', append('x'))).toThrow()
})

test('the user creates and restricts shared blocks', () => {
  const root = rootWithProject()
  const wiki = wikiDir(root)
  const input = (id: string | null, label: string | null, agents: string[], readOnly: boolean): BlockInput => ({ id, label, body: 'We ship on Fridays.', description: 'Team habits.', limit: 500, readOnly, agents })
  const created = saveAsUser(wiki, input(null, 'Team habits', ['a1'], false))
  expect(created.id).toBe('blocks/shared/team-habits')
  expect(() => saveAsUser(wiki, input(null, 'Team habits', [], false))).toThrow()
  expect(() => saveAsUser(wiki, input(null, 'user', [], false))).toThrow()
  expect(attached(root, agent('a1'), []).some((block) => block.id === created.id)).toBe(true)
  expect(attached(root, agent('a2'), []).some((block) => block.id === created.id)).toBe(false)
  expect(() => edit(root, agent('a2'), 'team-habits', append('x'))).toThrow()
  saveAsUser(wiki, input(created.id, null, [], true))
  expect(() => edit(root, agent('a1'), 'team-habits', append('x'))).toThrow('read-only')
  const rendered = render(attached(root, agent('a1'), []), agent('a1'), false)
  expect(rendered).toContain('<block label="team-habits" chars="19/500" read-only="true">')
  expect(rendered).toContain('<block label="persona" chars="0/2000">')
})
